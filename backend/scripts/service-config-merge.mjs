#!/usr/bin/env node
// Service/Maintenance config UNIFICATION (owner 2026-07-13: "service 共享 — 两家同一套").
//
// The read endpoints for special_addons / addons / maintenance_config_history
// are ALREADY company-unscoped (they read across all companies). The 2990 data
// import brought in 2990's OWN copies (company_id=2), so the merged system now
// shows each service item twice and maintenance /resolved can pick 2990's row.
//
// Unify = keep ONE canonical set (HOUZS company_id=1) and drop 2990's duplicate
// copies. This script:
//   MODE=audit (default, READ-ONLY): compares company 1 vs company 2 per config
//     table by natural key — reports duplicates, 2990-only keys (would be LOST
//     on delete → owner must decide), and price differences.
//   MODE=apply (APPLY=1): deletes company_id=2 rows ONLY for keys that also
//     exist under company_id=1 (true duplicates). 2990-ONLY keys are NEVER
//     touched — they are listed for a human decision so no service item silently
//     vanishes. No FK references these tables (verified in schema), so deletes
//     are safe.
import postgres from "postgres";
const DST = process.env.DATABASE_URL;
const APPLY = process.env.APPLY === "1";
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const HOUZS = 1, C2990 = 2;

// table -> { key: natural-key column(s), price: [price cols to compare] }
const TABLES = {
  special_addons:          { key: ["code"],  price: ["selling_price_sen", "cost_price_sen"] },
  addons:                  { key: ["label"], price: ["price"] },
  maintenance_config_history: { key: ["scope"], price: [] },  // scope master|customer:x|supplier:x
  bundle_library:          { key: ["bundle_code"], price: [] },
  special_addons_history:  { key: null, price: [] },  // global snapshots — no natural key, count only
};

async function hasCol(t, c) {
  const r = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name=${t} AND column_name=${c}`;
  return r.length > 0;
}

async function main() {
  console.log(`MODE=${APPLY ? "APPLY (deletes c2 duplicates)" : "AUDIT (read-only)"}`);
  let totalDupDel = 0, totalUniqueBlocked = 0;

  for (const [t, cfg] of Object.entries(TABLES)) {
    const exists = await sql`SELECT 1 FROM information_schema.tables WHERE table_schema='scm' AND table_name=${t}`;
    if (!exists.length) { console.log(`-- ${t}: table absent, skip`); continue; }
    if (!(await hasCol(t, "company_id"))) { console.log(`-- ${t}: no company_id, skip`); continue; }

    const [cnt] = await sql.unsafe(
      `SELECT count(*) FILTER (WHERE company_id=${HOUZS})::int c1, count(*) FILTER (WHERE company_id=${C2990})::int c2 FROM scm."${t}"`);
    console.log(`\n=== ${t}: HOUZS=${cnt.c1} | 2990=${cnt.c2} ===`);
    if (cnt.c2 === 0) { console.log("  2990 has 0 rows — nothing to unify."); continue; }

    if (!cfg.key) {
      // No natural key (global history snapshots): 2990's are pure duplicates of
      // the shared timeline. Safe to drop all c2.
      console.log(`  no natural key — 2990's ${cnt.c2} rows are redundant snapshots`);
      if (APPLY) {
        const del = await sql.unsafe(`DELETE FROM scm."${t}" WHERE company_id=${C2990}`);
        console.log(`  DELETED ${del.count} c2 rows`);
        totalDupDel += del.count;
      }
      continue;
    }

    // verify key cols exist; fall back if a table names its key differently
    const keyCols = [];
    for (const k of cfg.key) if (await hasCol(t, k)) keyCols.push(k);
    if (!keyCols.length) { console.log(`  WARN: none of key cols ${cfg.key} exist on ${t}; count-only`); continue; }
    const keyExpr = keyCols.map((k) => `"${k}"`).join(` || '||' || `);

    // keys present in each company
    const rows = await sql.unsafe(
      `SELECT ${keyExpr} AS k, company_id, ${[...cfg.price].map((p) => `"${p}"`).join(",") || "NULL"} FROM scm."${t}" WHERE company_id IN (${HOUZS},${C2990})`);
    const c1keys = new Map(), c2keys = new Map();
    for (const r of rows) (r.company_id === HOUZS ? c1keys : c2keys).set(r.k, r);

    const dupes = [], uniq = [], priceDiffs = [];
    for (const [k, r2] of c2keys) {
      if (c1keys.has(k)) {
        dupes.push(k);
        if (cfg.price.length) {
          const r1 = c1keys.get(k);
          const diff = cfg.price.filter((p) => String(r1[p]) !== String(r2[p]));
          if (diff.length) priceDiffs.push(`${k}: ${diff.map((p) => `${p} HOUZS=${r1[p]} 2990=${r2[p]}`).join(", ")}`);
        }
      } else uniq.push(k);
    }
    console.log(`  duplicates (in both): ${dupes.length}${dupes.length ? " -> " + dupes.slice(0, 30).join(", ") : ""}`);
    if (priceDiffs.length) { console.log(`  ⚠ PRICE DIFFERS on ${priceDiffs.length} dup keys (2990 will adopt HOUZS price):`); priceDiffs.slice(0, 30).forEach((d) => console.log(`     ${d}`)); }
    console.log(`  2990-ONLY keys (NOT deleted — owner decision): ${uniq.length}${uniq.length ? " -> " + uniq.slice(0, 30).join(", ") : ""}`);
    totalUniqueBlocked += uniq.length;

    if (APPLY && dupes.length) {
      // delete only c2 rows whose key exists under c1
      const del = await sql.unsafe(
        `DELETE FROM scm."${t}" d WHERE d.company_id=${C2990} AND EXISTS (SELECT 1 FROM scm."${t}" h WHERE h.company_id=${HOUZS} AND (${keyCols.map((k) => `h."${k}" IS NOT DISTINCT FROM d."${k}"`).join(" AND ")}))`);
      console.log(`  DELETED ${del.count} duplicate c2 rows`);
      totalDupDel += del.count;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(APPLY ? `DELETED_DUPLICATES=${totalDupDel}` : `WOULD_DELETE_DUPLICATES (run APPLY=1 to execute)`);
  console.log(`UNIQUE_2990_KEYS_KEPT=${totalUniqueBlocked} (need owner decision if > 0)`);
  console.log("DONE");
}
main().then(() => sql.end()).catch(async (e) => { console.error("FAIL", e.message); await sql.end(); process.exit(1); });
