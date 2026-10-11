// Postgres migration runner + tracker. Ported (trimmed) from Hookka's
// incremental runner. Applies every src/db/migrations-pg/*.sql once, in name
// order, recording each filename + checksum in a _pg_migrations tracker table;
// already-applied files are verified, then skipped. Each file runs inside a
// transaction (rollback on error).
//
// Build order for a fresh DB: load-d1-dump-to-pg.mjs (tables + data) THEN this
// (indexes + future schema changes). Migrations here must be idempotent
// (IF NOT EXISTS / ON CONFLICT) so applying to the live DB is always safe.
//
// Usage:
//   node scripts/pg-migrate.mjs            # apply pending
//   node scripts/pg-migrate.mjs --dry-run  # list pending, change nothing
//   node scripts/pg-migrate.mjs --verify-only # require an already-clean tracker
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { splitSqlStatements } from "./lib/split-sql.mjs";
import { pgSslMode } from "./lib/pg-ssl-mode.mjs";
import {
  ADOPTED_LEGACY_CHECKSUM,
  checksumMigrationSql,
  isGenesisTracker,
  planMigrationChecksums,
} from "./lib/migration-checksum.mjs";
import { loadAppliedMigrationRows } from "./lib/migration-tracker.mjs";
import { RETIRED_MIGRATIONS } from "./lib/migration-retirements.mjs";

const DRY = process.argv.includes("--dry-run");
const VERIFY_ONLY = process.argv.includes("--verify-only");
const READ_ONLY = DRY || VERIFY_ONLY;
const DIR = "src/db/migrations-pg";
// CI/deploy passes DATABASE_URL as an env var (GitHub secret); locally we read
// it from .dev.vars. Env wins so the deploy pipeline can apply migrations with
// no .dev.vars present.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}
/* TLS is REQUIRED, and pgSslMode is the only thing allowed to say otherwise:
   loopback only, spelled exactly, failing closed on anything it cannot parse
   (lib/pg-ssl-mode.mjs, tests/pgSslMode.node.mjs).

   Why the exception exists: with `ssl: "require"` hardcoded this script cannot
   reach ANY local PostgreSQL — it dies in 0.06s with "Client network socket
   disconnected before secure TLS connection was established", before reading a
   single migration file. So the only database a migration could ever be tried
   against was PRODUCTION, which is how mig 0290 first met a real server during
   a deploy (docs/migration-gate-coe.md). */
const pg = postgres(url, { ssl: pgSslMode(url), prepare: false, max: 1 });

/* A dry-run/verification is a production diagnostic, so it must be literally
   read-only. The helper introspects the catalog and projects NULL for a legacy
   tracker instead of "helpfully" creating or upgrading it. A normal apply owns
   the compatibility DDL and the one-time TOFU backfill below. */
const appliedRows = await loadAppliedMigrationRows(pg, { readOnly: READ_ONLY });

// Only top-level .sql files (skip the drizzle meta/ + the 0000 baseline, which
// the loader owns — tables are built by load-d1-dump-to-pg, not replayed here).
const filenames = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql") && f !== "0000_baseline.sql")
  .sort();
const files = await Promise.all(
  filenames.map(async (filename) => {
    const sql = readFileSync(path.join(DIR, filename), "utf8");
    return {
      filename,
      sql,
      checksum: await checksumMigrationSql(sql),
    };
  }),
);

// Genesis = this tracker has never been through the checksum runner, so the
// rows already in it carry no checksum and nothing can verify them. That trust
// happens exactly once, and everything it trusts is printed below.
const genesis = isGenesisTracker(appliedRows);

const { pending, backfill, drift, retired, renamed, adopted } =
  planMigrationChecksums(files, appliedRows, {
    retiredMigrations: RETIRED_MIGRATIONS,
    genesis,
  });

const newlyAdopted = adopted.filter((entry) => !entry.alreadyAdopted);

console.log(
  `${files.length} migration(s), ${appliedRows.length} applied, ` +
    `${pending.length} pending, ${backfill.length} checksum(s) to backfill, ` +
    `${retired.length} reviewed retirement(s), ${renamed.length} rename(s), ` +
    `${newlyAdopted.length} legacy row(s) to adopt` +
    (genesis ? " [GENESIS: first run of the checksum tracker]" : ""),
);

if (genesis && appliedRows.length > 0) {
  // The complete trust-on-first-use manifest, in the deploy log, every row.
  // This is what a production _pg_migrations dump would have told us, produced
  // by the runner itself at the moment it matters.
  console.log(
    `  TOFU    trusting ${appliedRows.length} pre-existing tracker row(s) without verification ` +
      "(the old runner stored no checksums; there is nothing to verify against):",
  );
  for (const row of appliedRows) console.log(`  TOFU    ${row.filename}`);
}

for (const entry of newlyAdopted) {
  console.log(
    `  ADOPT   ${entry.filename}: tracker row with no checksum and no file in the tree; ` +
      (READ_ONLY
        ? "would be adopted and stamped by a normal apply run"
        : "adopting once and stamping it immutable") +
      (entry.suspectedRenumberOf
        ? ` (looks like it was renumbered to ${entry.suspectedRenumberOf})`
        : ""),
  );
}

if (drift.length > 0) {
  console.error("Migration drift detected. Applied migration history is immutable:");
  for (const item of drift) {
    if (item.reason === "retired_filename_reused") {
      console.error(
        `  DRIFT   ${item.filename}: this historical filename is retired and may never be reused`,
      );
    } else if (item.reason === "retired_checksum_mismatch") {
      console.error(
        `  DRIFT   ${item.filename}: retired row checksum ${item.storedChecksum} ` +
          `does not match archived ${item.currentChecksum}`,
      );
    } else if (item.reason === "legacy_file_deleted_unverifiable") {
      console.error(
        `  DRIFT   ${item.filename}: legacy tracker row has no checksum and ` +
          "the migration file is missing; applied history cannot be verified. " +
          "This tracker is past genesis, so the row was inserted by hand or by " +
          "an older runner after the fact — investigate before unblocking." +
          (item.suspectedRenumberOf
            ? ` It may be a renumber of ${item.suspectedRenumberOf}.`
            : ""),
      );
    } else if (item.reason === "probable_renumber") {
      console.error(
        `  DRIFT   ${item.filename}: gone from the tree, but ${item.suspectedRenumberOf} ` +
          "has the same name after the number — this looks like a RENUMBER whose " +
          "content also changed, so it cannot be proven to be the same migration.",
      );
      console.error(
        `          If it is the same migration and the SQL already ran, repoint the row:\n` +
          `            UPDATE _pg_migrations SET filename = '${item.suspectedRenumberOf}', checksum = NULL\n` +
          `             WHERE filename = '${item.filename}';\n` +
          `          The next run backfills the new checksum without re-running the SQL.\n` +
          `          If it is NOT the same migration, an applied file was edited — add a new one instead.`,
      );
    } else if (item.reason === "file_deleted") {
      console.error(
        `  DRIFT   ${item.filename}: file deleted (stored ${item.storedChecksum})`,
      );
    } else {
      console.error(
        `  DRIFT   ${item.filename}: stored ${item.storedChecksum}, ` +
          `current ${item.currentChecksum}`,
      );
    }
  }
  console.error("Add a new migration instead of editing or deleting an applied one.");
  await pg.end();
  process.exit(1);
}

for (const item of renamed) {
  console.log(
    `  RENAMED ${item.from} -> ${item.to}: identical checksum ${item.checksum}, ` +
      "so the SQL has already been applied under the old name and will NOT be re-run" +
      (READ_ONLY ? " (read-only run; the tracker row is not repointed here)" : ""),
  );
}

if (DRY) {
  for (const item of retired) console.log(`  RETIRED ${item.filename}`);
  for (const file of backfill) console.log(`  BACKFILL ${file.filename}`);
  for (const file of pending) console.log(`  PENDING ${file.filename}`);
  await pg.end();
  process.exit(0);
}

if (VERIFY_ONLY) {
  for (const item of retired) console.log(`  RETIRED ${item.filename}`);
  for (const file of backfill) console.error(`  UNVERIFIED ${file.filename}: checksum backfill required`);
  for (const entry of newlyAdopted) console.error(`  UNADOPTED ${entry.filename}: legacy row not yet adopted`);
  for (const item of renamed) console.error(`  UNREPOINTED ${item.from} -> ${item.to}`);
  for (const file of pending) console.error(`  PENDING ${file.filename}`);
  if (
    backfill.length > 0 ||
    pending.length > 0 ||
    newlyAdopted.length > 0 ||
    renamed.length > 0
  ) {
    console.error(
      "Schema verification failed: apply migrations normally before deploying this Worker.",
    );
    await pg.end();
    process.exit(1);
  }
  console.log("Schema verification passed; tracker and migration tree are clean.");
  await pg.end();
  process.exit(0);
}

if (backfill.length > 0 || renamed.length > 0 || newlyAdopted.length > 0) {
  try {
    await pg.begin(async (tx) => {
      for (const item of renamed) {
        // Repoint, never re-run. The checksum proves byte-identical SQL, so the
        // tracker row is simply carried over to the file's new number. The
        // predicates keep this safe under a concurrent peer: if another runner
        // already repointed the row, ours matches nothing and we stop.
        const moved = await tx`
          UPDATE _pg_migrations
          SET filename = ${item.to}
          WHERE filename = ${item.from}
            AND checksum = ${item.checksum}
            AND NOT EXISTS (
              SELECT 1 FROM _pg_migrations existing WHERE existing.filename = ${item.to}
            )
          RETURNING filename
        `;
        if (moved.length !== 1) {
          throw new Error(
            `Migration drift detected while repointing ${item.from} to ${item.to}; ` +
              "the tracker row changed under this runner",
          );
        }
      }
      for (const entry of newlyAdopted) {
        // Stamp the unverifiable legacy row so it is adopted exactly once and
        // any later reappearance of the same filename is content_changed drift.
        const stamped = await tx`
          UPDATE _pg_migrations
          SET checksum = ${ADOPTED_LEGACY_CHECKSUM}
          WHERE filename = ${entry.filename}
            AND (checksum IS NULL OR checksum = ${ADOPTED_LEGACY_CHECKSUM})
          RETURNING checksum
        `;
        if (stamped.length !== 1) {
          throw new Error(
            `Migration drift detected while adopting ${entry.filename}; ` +
              "another runner stored a different checksum",
          );
        }
      }
      for (const file of backfill) {
        // The second predicate makes concurrent first-rollout runners safe. A
        // peer may have backfilled the same checksum since our initial SELECT;
        // that is fine. A different checksum means two deploys disagree about
        // immutable history, so this runner must stop before applying anything.
        const updated = await tx`
          UPDATE _pg_migrations
          SET checksum = ${file.checksum}
          WHERE filename = ${file.filename}
            AND (checksum IS NULL OR checksum = ${file.checksum})
          RETURNING checksum
        `;
        if (updated.length !== 1) {
          throw new Error(
            `Migration drift detected while backfilling ${file.filename}; ` +
              "another runner stored a different checksum",
          );
        }
      }
    });
  } catch (e) {
    console.error(
      `  FAILED  tracker reconciliation: ${String(e.message || e).slice(0, 240)}`,
    );
    await pg.end();
    process.exit(1);
  }
  for (const item of renamed) {
    console.log(`  REPOINTED ${item.from} -> ${item.to} (${item.checksum})`);
  }
  for (const entry of newlyAdopted) {
    console.log(`  ADOPTED ${entry.filename} (${ADOPTED_LEGACY_CHECKSUM})`);
  }
  for (const file of backfill) {
    console.log(`  BACKFILLED ${file.filename} (${file.checksum})`);
  }
}

for (const file of pending) {
  // Multi-statement files run statement-by-statement inside one transaction
  // (postgres.js .unsafe runs a single statement at a time). The splitter is
  // dollar-quote aware, so a PL/pgSQL body survives intact — see
  // scripts/lib/split-sql.mjs.
  const stmts = splitSqlStatements(file.sql);
  try {
    await pg.begin(async (tx) => {
      for (const s of stmts) await tx.unsafe(s);
      await tx`
        INSERT INTO _pg_migrations (filename, checksum)
        VALUES (${file.filename}, ${file.checksum})
      `;
    });
    console.log(
      `  APPLIED ${file.filename} (${stmts.length} statements, ${file.checksum})`,
    );
  } catch (e) {
    console.error(
      `  FAILED  ${file.filename}: ${String(e.message || e).slice(0, 160)}`,
    );
    await pg.end();
    process.exit(1);
  }
}
console.log("done");
await pg.end();
