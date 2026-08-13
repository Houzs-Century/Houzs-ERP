// repair-lorry-plates.mjs — canonicalise lorry plates, and merge the rows that
// were only ever separate because of a space.
//
// EVIDENCE (owner, 2026-08-01, from the live Fleet Health board): `AKF 8100` and
// `AKF8100` are listed as two lorries, both showing driver "Mohamad Basri".
// `scm.lorries.plate` is NOT NULL UNIQUE (mig 0053), but the uniqueness is over
// the RAW string — a space, hyphen or lowercase letter buys a second row for a
// vehicle that already exists, and the two then accumulate separate compliance
// documents, service history, mileage and trips.
//
// TWO PARTS, deliberately separate, because their risk is not comparable:
//
//   renames  A row whose canonical plate nothing else claims. One UPDATE of one
//            text column. Reversible, touches no foreign key.
//   merges   Two or more rows for one vehicle. Every referencing row must be
//            re-pointed and the loser deleted. NOT reversible.
//
// THE REFERENCING TABLES ARE DISCOVERED FROM THE LIVE CATALOG, never from the
// migration tree. This repo has already been bitten by assuming otherwise: the
// user-delete incident (BUG-HISTORY, 2026-08-01) found a trigger on public.users
// that exists in production and appears nowhere in this codebase, and a column
// the schema file declares that production does not have. A merge that misses
// one FK leaves orphaned history; asking pg_constraint cannot miss one.
//
// WHICH ROW SURVIVES is decided by scm/lib/plate-normalize.ts (pickSurvivor) —
// the same pure, unit-tested function the dry run reports from, so the plan you
// review is exactly the plan that applies. Most-referenced wins, so the fewest
// rows in production have to move.
//
// DRY-RUN by default. APPLY=1 to write. Read-only until then — no DDL, no
// writes, and the dry run runs no transaction at all.
//
//   DATABASE_URL   required (env, or .dev.vars for local use)
//   APPLY=1        write. Anything else is a dry run.
//   PART           renames | merges | all   (default all)
//   MAX_ROWS       rows to print per section (default 100)
//
// RE-RUN: inert. A canonicalised plate is already canonical, and a merged loser row is gone.

import { readFileSync } from "node:fs";
import { register } from "node:module";
register("./_ts-resolve.mjs", import.meta.url);

import postgres from "postgres";

const { normalizePlate, findDuplicateGroups, findRenames } =
  await import("../src/scm/lib/plate-normalize.ts");

const APPLY = process.env.APPLY === "1";
const PART = (process.env.PART || "all").trim().toLowerCase();
const MAX_ROWS = Number(process.env.MAX_ROWS || 100);
if (!["all", "renames", "merges"].includes(PART)) {
  console.error(`PART must be all | renames | merges (got "${PART}")`);
  process.exit(2);
}
const doRenames = PART === "all" || PART === "renames";
const doMerges = PART === "all" || PART === "merges";

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

const log = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  log(APPLY ? "MODE: APPLY (writes)" : "MODE: DRY RUN (no writes)");

  // ── Every foreign key pointing at scm.lorries, from the catalog ───────────
  const fks = await pg`
    SELECT n.nspname   AS schema_name,
           c.relname   AS table_name,
           a.attname   AS column_name
      FROM pg_constraint con
      JOIN pg_class     c  ON c.oid = con.conrelid
      JOIN pg_namespace n  ON n.oid = c.relnamespace
      JOIN pg_class     rc ON rc.oid = con.confrelid
      JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum = k.attnum
     WHERE con.contype = 'f'
       AND rn.nspname = 'scm'
       AND rc.relname = 'lorries'
     ORDER BY 1, 2, 3`;

  log(`Referencing columns found in the live catalog: ${fks.length}`);
  for (const f of fks) log(`  ${f.schema_name}.${f.table_name}.${f.column_name}`);
  if (fks.length === 0) {
    log("No foreign keys reference scm.lorries. A merge would be a plain delete — refusing to guess; stopping.");
    return;
  }

  // ── The fleet, with a reference count per row ─────────────────────────────
  const lorries = await pg`
    SELECT id::text AS id, plate, active, created_at
      FROM scm.lorries
     ORDER BY plate`;
  log(`Lorries: ${lorries.length}`);

  const refCount = new Map();
  for (const l of lorries) refCount.set(l.id, 0);
  for (const f of fks) {
    const rows = await pg`
      SELECT ${pg(f.column_name)}::text AS lorry_id, count(*)::int AS n
        FROM ${pg(f.schema_name)}.${pg(f.table_name)}
       WHERE ${pg(f.column_name)} IS NOT NULL
       GROUP BY 1`;
    for (const r of rows) {
      if (refCount.has(r.lorry_id)) refCount.set(r.lorry_id, refCount.get(r.lorry_id) + r.n);
    }
  }

  const rows = lorries.map((l) => ({
    id: l.id,
    plate: l.plate,
    active: l.active !== false,
    createdAt: l.created_at ? new Date(l.created_at).toISOString() : null,
    refs: refCount.get(l.id) ?? 0,
  }));

  // ── Part 1: renames ───────────────────────────────────────────────────────
  const renames = findRenames(rows);
  if (doRenames) {
    log(`\n== RENAMES (canonical form is free) : ${renames.length}`);
    for (const r of renames.slice(0, MAX_ROWS)) log(`  "${r.from}" -> "${r.to}"`);
    if (renames.length > MAX_ROWS) log(`  ... and ${renames.length - MAX_ROWS} more (raise MAX_ROWS to see them)`);

    if (APPLY && renames.length > 0) {
      for (const r of renames) {
        await pg`UPDATE scm.lorries SET plate = ${r.to}, updated_at = now() WHERE id = ${r.id}::uuid`;
      }
      log(`APPLIED: ${renames.length} plate(s) canonicalised.`);
    }
  }

  // ── Part 2: merges ────────────────────────────────────────────────────────
  const groups = findDuplicateGroups(rows);
  if (doMerges) {
    log(`\n== MERGE GROUPS (one vehicle, several rows) : ${groups.length}`);
    for (const g of groups.slice(0, MAX_ROWS)) {
      log(`  ${g.canonical}`);
      log(`    SURVIVOR "${g.survivor.plate}" id=${g.survivor.id} refs=${g.survivor.refs} ${g.survivor.active ? "active" : "inactive"}`);
      for (const l of g.losers) {
        log(`    merge in "${l.plate}" id=${l.id} refs=${l.refs} ${l.active ? "active" : "inactive"}`);
      }
    }
    if (groups.length > MAX_ROWS) log(`  ... and ${groups.length - MAX_ROWS} more`);

    if (APPLY && groups.length > 0) {
      for (const g of groups) {
        /* One transaction per GROUP. A half-merged lorry — some history moved,
           some not — is worse than an unmerged one, and per-group scoping keeps
           one bad group from rolling back the good ones. */
        await pg.begin(async (tx) => {
          for (const loser of g.losers) {
            for (const f of fks) {
              await tx`
                UPDATE ${tx(f.schema_name)}.${tx(f.table_name)}
                   SET ${tx(f.column_name)} = ${g.survivor.id}::uuid
                 WHERE ${tx(f.column_name)} = ${loser.id}::uuid`;
            }
            await tx`DELETE FROM scm.lorries WHERE id = ${loser.id}::uuid`;
          }
          /* The survivor keeps the canonical plate. Done INSIDE the transaction
             and AFTER the losers are gone, so the UNIQUE index can never see two
             rows claiming the canonical form at once. */
          await tx`UPDATE scm.lorries SET plate = ${g.canonical}, updated_at = now() WHERE id = ${g.survivor.id}::uuid`;
        });
        log(`APPLIED: ${g.canonical} — ${g.losers.length} row(s) merged in.`);
      }
    }
  }

  // ── What was deliberately left alone ─────────────────────────────────────
  const junk = rows.filter((r) => !normalizePlate(r.plate));
  if (junk.length > 0) {
    log(`\n== LEFT ALONE: ${junk.length} row(s) whose plate has no letters or digits at all.`);
    for (const j of junk.slice(0, MAX_ROWS)) log(`  id=${j.id} plate="${j.plate}" refs=${j.refs}`);
    log("  These are not renamed (canonical form would be empty) and not grouped (they are not the same vehicle).");
  }

  log(`\nSUMMARY: ${renames.length} rename(s), ${groups.length} merge group(s), ${junk.length} unusable plate(s).`);
  if (!APPLY) log("DRY RUN — nothing was written. Re-run with APPLY=1 after reviewing the plan above.");
}

main()
  .then(() => pg.end())
  .catch(async (e) => {
    console.error(e);
    await pg.end();
    process.exit(1);
  });
