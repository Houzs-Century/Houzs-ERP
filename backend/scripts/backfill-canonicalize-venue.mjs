#!/usr/bin/env node
// Fold showroom-venue ALIASES to their canonical name across every surface that
// stores a venue, so the same physical place stops showing up twice ("PJ Showroom"
// vs "2990s PJ"). Complements backfill-2990-so-venue.mjs (which only filled BLANK
// 2990 SOs) — this one collapses aliases on already-populated rows everywhere.
//
// The alias->canonical map below MUST stay in sync with the runtime front door
// backend/src/scm/lib/canonical-venue.ts (same rule, two entry points — the TS helper
// guards new writes, this script cleans the existing rows). Owner 2026-07-29: every
// surface that displays this venue must read "2990s PJ".
//
// Surfaces folded (all idempotent, alias-only — never touches a non-alias venue):
//   1. projects.venue                 (PMS free-text)
//   2. scm.mfg_sales_orders.venue     (SO free-text)
//   3. scm.warehouses.venue_name      (showroom master)
//   4. project_venues.name            (picker) — renamed ONLY when no canonical row
//      already exists in that company; a genuine duplicate is REPORTED, and merged
//      (venue_id repoint + delete) only when MERGE_PICKER=1 (repointing FKs is the
//      one risky op, so it is opt-in).
//
// APPLY=1 to write; DRY-RUN otherwise. MERGE_PICKER=1 to also merge duplicate picker rows.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const MERGE_PICKER = process.env.MERGE_PICKER === "1";
const dst = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

// KEEP IN SYNC with backend/src/scm/lib/canonical-venue.ts AND the SQL guards in
// backend/src/db/migrations-pg/*_venue_canonicalize.sql (+ its D1 parity file).
const CANONICAL_MAP = {
  "2990s PJ": ["pj showroom", "pj-showroom", "pjshowroom", "2990s pj", "2990spj", "2990 pj", "2990pj"],
};
const key = (s) => String(s).toLowerCase().trim().replace(/\s+/g, " ");
// variant keys per canonical, EXCLUDING the canonical's own key (those are already fine).
const aliasKeysFor = (canon) => CANONICAL_MAP[canon].filter((v) => key(v) !== key(canon));

async function foldTextColumn(table, col, canon, aliasKeys, companyCol) {
  // Count aliases (not already canonical).
  const [{ n }] = await dst.unsafe(
    `SELECT count(*)::int AS n FROM ${table}
      WHERE lower(btrim(${col})) = ANY($1) AND ${col} <> $2`,
    [aliasKeys, canon]
  );
  if (n === 0) { log(`  ${table}.${col}: 0 alias rows.`); return 0; }
  if (!APPLY) { log(`  ${table}.${col}: WOULD fold ${n} alias row(s) -> "${canon}".`); return n; }
  const res = await dst.unsafe(
    `UPDATE ${table} SET ${col} = $2 WHERE lower(btrim(${col})) = ANY($1) AND ${col} <> $2`,
    [aliasKeys, canon]
  );
  log(`  ${table}.${col}: folded ${res.count} row(s) -> "${canon}".`);
  return res.count;
}

async function foldPicker(canon, aliasKeys) {
  // Per company: rename alias rows to canonical when no canonical row exists there;
  // otherwise it is a duplicate — report (and merge only under MERGE_PICKER).
  const aliasRows = await dst.unsafe(
    `SELECT id, name, company_id FROM project_venues WHERE lower(btrim(name)) = ANY($1)`,
    [aliasKeys]
  );
  if (aliasRows.length === 0) { log(`  project_venues: 0 alias picker rows.`); return; }
  for (const row of aliasRows) {
    const [canonRow] = await dst.unsafe(
      `SELECT id FROM project_venues WHERE lower(btrim(name)) = $1 AND company_id IS NOT DISTINCT FROM $2 AND id <> $3`,
      [key(canon), row.company_id, row.id]
    );
    if (!canonRow) {
      if (!APPLY) { log(`  project_venues #${row.id} (co=${row.company_id}): WOULD rename "${row.name}" -> "${canon}".`); continue; }
      await dst.unsafe(`UPDATE project_venues SET name = $1 WHERE id = $2`, [canon, row.id]);
      log(`  project_venues #${row.id}: renamed "${row.name}" -> "${canon}".`);
    } else if (MERGE_PICKER && APPLY) {
      // Repoint any SO venue_id from the alias row to the canonical row, then delete alias.
      const rp = await dst.unsafe(
        `UPDATE scm.mfg_sales_orders SET venue_id = $1 WHERE venue_id = $2`,
        [canonRow.id, row.id]
      );
      await dst.unsafe(`DELETE FROM project_venues WHERE id = $1`, [row.id]);
      log(`  project_venues #${row.id}: MERGED into #${canonRow.id} (repointed ${rp.count} SO venue_id), alias row deleted.`);
    } else {
      log(`  project_venues #${row.id} (co=${row.company_id}): DUPLICATE of canonical #${canonRow.id} — left as-is. Re-run MERGE_PICKER=1 APPLY=1 to merge.`);
    }
  }
}

async function main() {
  log(`mode=${APPLY ? "APPLY" : "DRY-RUN"}${MERGE_PICKER ? " MERGE_PICKER" : ""}`);
  for (const canon of Object.keys(CANONICAL_MAP)) {
    const aliasKeys = aliasKeysFor(canon);
    log("");
    log(`=== canonical "${canon}"  (aliases: ${aliasKeys.join(", ")}) ===`);
    await foldTextColumn("projects", "venue", canon, aliasKeys);
    await foldTextColumn("scm.mfg_sales_orders", "venue", canon, aliasKeys);
    await foldTextColumn("scm.warehouses", "venue_name", canon, aliasKeys);
    await foldPicker(canon, aliasKeys);
  }
  if (!APPLY) { log(""); log("DRY-RUN complete. Re-run with APPLY=1 to write."); }
}

main().then(() => dst.end()).catch(async (e) => {
  console.error("VENUE_CANON_FAIL", e.message);
  try { await dst.end(); } catch {}
  process.exit(1);
});
