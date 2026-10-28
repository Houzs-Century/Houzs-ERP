/**
 * Return the canonical bytes used by the migration drift gate.
 *
 * Git may check the same SQL file out as CRLF on Windows and LF in CI. Those
 * byte-level differences do not change the migration, so normalise line
 * endings before hashing. Everything else (including comments/whitespace) is
 * deliberately significant: applied migration files are immutable history.
 */
export function canonicalizeMigrationSql(sql) {
  return sql.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export async function checksumMigrationSql(sql) {
  const bytes = new TextEncoder().encode(canonicalizeMigrationSql(sql));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/**
 * Sentinel stored in `_pg_migrations.checksum` for a pre-checksum tracker row
 * whose migration file no longer exists. Nothing can prove such a row (there is
 * no checksum and no file), so it is adopted once, by name, and recorded — see
 * `isGenesisTracker` for why that is strictly safer than failing closed.
 */
export const ADOPTED_LEGACY_CHECKSUM = "legacy-adopted";

/**
 * True when this tracker has never been through the checksum runner.
 *
 * The very first run has to trust what is already applied: 160-odd rows written
 * by the old runner carry no checksum, so there is nothing to verify them
 * against. That is unavoidable trust-on-first-use. What matters is that it
 * happens ONCE, that it is recorded in the database, and that it is printed.
 *
 * Deriving genesis from the DATA (no row carries a checksum yet) rather than
 * from the schema (the `checksum` column is missing) is deliberate: adding the
 * column and backfilling it are separate statements, so a run that dies between
 * them must still be able to finish the job on the next attempt. Once any row
 * has a real checksum the tracker is past genesis forever, and every later
 * unexplained row is hard drift.
 */
export function isGenesisTracker(appliedRows) {
  return appliedRows.every((row) => !row.checksum);
}

/** `0167_foo.sql` -> `foo.sql`; used only to NAME a suspected renumber. */
function migrationStem(filename) {
  return filename.replace(/^\d+_/, "");
}

/**
 * Classify the local migration tree against tracker rows already in Postgres.
 *
 * `checksum = null` is the one-time compatibility state created by the old
 * runner. Existing files in that state are trusted once and backfilled. Once a
 * row has a checksum, both content changes and file deletion are fail-closed
 * drift.
 *
 * Two things a naive "file is gone => drift" rule gets dangerously wrong here:
 *
 * 1. RENUMBERS. Migration numbers in this repo are assigned at merge time
 *    against whatever main looks like that minute, so `git mv 0165_x 0167_x` is
 *    routine. If the old number ever reached a tracker — which is exactly what
 *    happens on the `staging` branch, since staging deploys before main — the
 *    old filename is in that tracker forever and the new one looks pending.
 *    Fail-closed on the missing old name would brick that environment
 *    permanently. When the orphan's checksum matches a pending file's checksum
 *    EXACTLY and that match is unambiguous, this is a rename: the SQL provably
 *    already ran, so the runner repoints the tracker row and does not re-run
 *    it. When the content also changed, it cannot be proven and is reported as
 *    `probable_renumber` naming both filenames, which is a loud, actionable
 *    stop rather than a mystery.
 *
 * 2. PRE-CHECKSUM ORPHANS. A legacy row with no checksum whose file is gone
 *    cannot be verified by any means, dump included. Failing closed on it buys
 *    no safety and blocks the deploy — and in this repo a blocked migration run
 *    blocks every later migration. On the genesis run those rows are adopted
 *    and stamped, and the runner prints each one. After genesis they are hard
 *    drift.
 */
export function planMigrationChecksums(localFiles, appliedRows, options = {}) {
  const localByName = new Map(localFiles.map((file) => [file.filename, file]));
  const appliedByName = new Map(appliedRows.map((row) => [row.filename, row]));
  const retiredByName = new Map(
    (options.retiredMigrations ?? []).map((entry) => [entry.filename, entry]),
  );
  const genesis = options.genesis ?? false;

  const pending = [];
  const backfill = [];
  const drift = [];
  const retired = [];
  const renamed = [];
  const adopted = [];

  for (const file of localFiles) {
    if (retiredByName.has(file.filename)) {
      drift.push({
        filename: file.filename,
        storedChecksum: null,
        currentChecksum: file.checksum,
        reason: "retired_filename_reused",
      });
      continue;
    }
    const applied = appliedByName.get(file.filename);
    if (!applied) {
      pending.push(file);
      continue;
    }

    if (!applied.checksum) {
      backfill.push(file);
      continue;
    }

    if (applied.checksum !== file.checksum) {
      drift.push({
        filename: file.filename,
        storedChecksum: applied.checksum,
        currentChecksum: file.checksum,
        reason: "content_changed",
      });
    }
  }

  // Orphans = tracker rows with no file of that name. Index the pending files
  // by checksum so an orphan can be recognised as a RENAME of one of them.
  const orphans = appliedRows.filter((row) => !localByName.has(row.filename));
  const pendingByChecksum = new Map();
  for (const file of pending) {
    const bucket = pendingByChecksum.get(file.checksum) ?? [];
    bucket.push(file);
    pendingByChecksum.set(file.checksum, bucket);
  }
  const orphanCountByChecksum = new Map();
  for (const row of orphans) {
    if (!row.checksum || row.checksum === ADOPTED_LEGACY_CHECKSUM) continue;
    orphanCountByChecksum.set(
      row.checksum,
      (orphanCountByChecksum.get(row.checksum) ?? 0) + 1,
    );
  }
  const renamedTo = new Set();

  function resolveRename(applied) {
    if (!applied.checksum || applied.checksum === ADOPTED_LEGACY_CHECKSUM) return null;
    // Ambiguity is not resolved by guessing. Both sides must be unique.
    if (orphanCountByChecksum.get(applied.checksum) !== 1) return null;
    const candidates = pendingByChecksum.get(applied.checksum) ?? [];
    if (candidates.length !== 1) return null;
    if (renamedTo.has(candidates[0].filename)) return null;
    return candidates[0];
  }

  /** Names a pending file that looks like the same migration under a new number. */
  function suspectedRenumber(filename) {
    const stem = migrationStem(filename);
    const matches = pending.filter(
      (file) => migrationStem(file.filename) === stem && !renamedTo.has(file.filename),
    );
    return matches.length === 1 ? matches[0].filename : null;
  }

  for (const applied of orphans) {
    const retirement = retiredByName.get(applied.filename);
    if (retirement) {
      if (applied.checksum && applied.checksum !== retirement.archivedChecksum) {
        drift.push({
          filename: applied.filename,
          storedChecksum: applied.checksum,
          currentChecksum: retirement.archivedChecksum,
          reason: "retired_checksum_mismatch",
        });
      } else {
        retired.push({
          filename: applied.filename,
          storedChecksum: applied.checksum ?? null,
          archivedChecksum: retirement.archivedChecksum,
          gitBlob: retirement.gitBlob,
        });
      }
      continue;
    }
    if (applied.checksum === ADOPTED_LEGACY_CHECKSUM) {
      // Already adopted by an earlier genesis run. Carry it forward silently
      // so it never has to be adopted twice.
      adopted.push({ filename: applied.filename, alreadyAdopted: true });
      continue;
    }

    const rename = resolveRename(applied);
    if (rename) {
      renamedTo.add(rename.filename);
      renamed.push({
        from: applied.filename,
        to: rename.filename,
        checksum: applied.checksum,
      });
      continue;
    }

    const suspect = suspectedRenumber(applied.filename);

    if (applied.checksum) {
      drift.push({
        filename: applied.filename,
        storedChecksum: applied.checksum,
        currentChecksum: suspect ? (localByName.get(suspect)?.checksum ?? null) : null,
        suspectedRenumberOf: suspect,
        reason: suspect ? "probable_renumber" : "file_deleted",
      });
    } else if (genesis) {
      // Nothing exists to verify this row against — no checksum, no file, and
      // no dump could produce one. Adopt it, stamp it, and print it.
      adopted.push({
        filename: applied.filename,
        alreadyAdopted: false,
        suspectedRenumberOf: suspect,
      });
    } else {
      drift.push({
        filename: applied.filename,
        storedChecksum: null,
        currentChecksum: null,
        suspectedRenumberOf: suspect,
        reason: "legacy_file_deleted_unverifiable",
      });
    }
  }

  // A renamed file has provably already been applied under its old name, so it
  // must not be replayed.
  const stillPending = pending.filter((file) => !renamedTo.has(file.filename));

  return { pending: stillPending, backfill, drift, retired, renamed, adopted };
}
