#!/usr/bin/env node
// Align the 2026-08-29 new-code rows to the family's long-name convention.
//
// The 30-char-truncation repair (docs/bugs/0567) first minted SHORT ERP names
// (DL-CS2 ... MATT (K)) while the family's established convention — visible on
// the S/SS rows the proper first pass created — is the long form (DUNLOPILLO
// COOLSILK 2.0 ...). The mapping CSV now carries the long names; this one-shot
// renames the rows the short names already reached: the day-old balance cells
// (inventory_movements + inventory_lots) and the 17 imported SO lines. All are
// migration-born rows from the last 24h; nothing human-edited.
//
// MODE: plan (default) counts per table per code; APPLY=1 +
// CONFIRM="RENAME NEW CODE ROWS" writes.
// RE-RUN: inert — the old names no longer match anything after the first run.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
if (APPLY && process.env.CONFIRM !== "RENAME NEW CODE ROWS") {
  console.error('APPLY=1 needs CONFIRM="RENAME NEW CODE ROWS" — refusing.');
  process.exit(2);
}
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const REN = {
  "DL-CS2 ARCTIC DREAM MATT (K)": "DUNLOPILLO COOLSILK 2.0 ARCTIC DREAM MATT (K)",
  "DL-CS2 ARCTIC DREAM MATT (Q)": "DUNLOPILLO COOLSILK 2.0 ARCTIC DREAM MATT (Q)",
  "DL-CS2 NANO BREEZE MATT (K)": "DUNLOPILLO COOLSILK 2.0 NANO BREEZE MATT (K)",
  "DL-CS2 NANO BREEZE MATT (Q)": "DUNLOPILLO COOLSILK 2.0 NANO BREEZE MATT (Q)",
  "DL-CS2 NN-WINTER DREAM MATT (K)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER DREAM MATT (K)",
  "DL-CS2 NN-WINTER DREAM MATT (Q)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER DREAM MATT (Q)",
  "DL-CS2 NN-WINTER FLOW MATT (K)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER FLOW MATT (K)",
  "DL-CS2 NN-WINTER FLOW MATT (Q)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER FLOW MATT (Q)",
  "DL-CS2 NN-WINTER FROST MATT (K)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER FROST MATT (K)",
  "DL-CS2 NN-WINTER FROST MATT (Q)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER FROST MATT (Q)",
  "DL-CS2 NN-WINTER REST MATT (K)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER REST MATT (K)",
  "DL-CS2 NN-WINTER REST MATT (Q)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER REST MATT (Q)",
  "DL-CS2 NN-WINTER SLEEP MATT (K)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER SLEEP MATT (K)",
  "DL-CS2 NN-WINTER SLEEP MATT (Q)": "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER SLEEP MATT (Q)",
};
const TABLES = [
  ["inventory_movements", "item_code"],
  ["inventory_lots", "item_code"],
  ["mfg_sales_order_items", "item_code"],
];

async function main() {
  log(`mode=${APPLY ? "APPLY" : "PLAN"}; renames: ${Object.keys(REN).length}`);
  let total = 0;
  for (const [table, col] of TABLES) {
    for (const [oldC, newC] of Object.entries(REN)) {
      const [{ n }] = await sql.unsafe(
        `SELECT COUNT(*)::int AS n FROM scm.${table} WHERE ${col} = $1`, [oldC]);
      if (Number(n) === 0) continue;
      total += Number(n);
      log(`  ${table}: ${n} row(s) ${JSON.stringify(oldC)} -> ${JSON.stringify(newC)}`);
      if (APPLY) {
        await sql.unsafe(
          `UPDATE scm.${table} SET ${col} = $2 WHERE ${col} = $1`, [oldC, newC]);
      }
    }
  }
  log(`${APPLY ? "renamed" : "would rename"}: ${total} row(s) across ${TABLES.length} tables`);
  if (APPLY) {
    const vsql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
    let leftoverOld = 0;
    for (const [table, col] of TABLES) {
      const [{ n }] = await vsql.unsafe(
        `SELECT COUNT(*)::int AS n FROM scm.${table} WHERE ${col} = ANY($1)`, [Object.keys(REN)]);
      leftoverOld += Number(n);
    }
    if (leftoverOld > 0) { log(`VERIFY FAILED: ${leftoverOld} row(s) still carry an old name`); await vsql.end(); await sql.end(); process.exit(1); }
    log("VERIFY (fresh connection): zero rows carry any old name.");
    await vsql.end();
  } else {
    log('PLAN ONLY — APPLY=1 CONFIRM="RENAME NEW CODE ROWS" writes.');
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
