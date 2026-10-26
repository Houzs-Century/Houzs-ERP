// Merge one product that sits under two catalogue codes into the code the
// business keeps. PLAN BY DEFAULT: nothing is written unless MODE=apply and
// CONFIRM repeats the phrase this run prints.
//
// The pairs are not typed on the command line: TICKET names an entry in
// data/duplicate-sku-merges.json, which carries the pairs and who ruled on them.
// BUG-38 (2026-09-29): AKEMI SOLITUDE MATT (Q/S/SK/SP) merge into HAPPI SLEEP
// SOLITUDE MATT (Q/S/SK/SP). The rules live once, in lib/duplicate-sku-merge-plan.mjs.
//
// WHAT IT WRITES, per pair and in one transaction:
//   - every PRODUCT_CODE_CASCADE column (the columns a rename moves: SO, PO, DO,
//     GRN, PI and consignment lines, amendments, stock ledger, lots, racks)
//     re-keyed from the dropped code to the kept one, row by row by id;
//   - the dropped catalogue row set INACTIVE once nothing is left on it.
// WHAT IT NEVER TOUCHES: descriptions, qty, prices, variants; supplier bindings,
// price and cost history on the dropped code (the kept SKU has its own; they go
// inert with the row); AutoCount - a raw SQL change queues no write-back.
//
// OUTPUT: counts and product codes, plus the re-keyed row ids (the undo), because
// this repository's Actions logs are public: no document numbers, no money.
//
//   DATABASE_URL  required
//   TICKET        required, a key of data/duplicate-sku-merges.json (e.g. BUG-38)
//   MODE          plan (default, writes nothing) | apply
//   CONFIRM       on apply, the phrase this run prints; it carries the counts it
//                 measured, so a phrase copied from an older run cannot fire
//   COMPANY_ID    default 1
//
// RE-RUN: convergent. A re-keyed row no longer carries the dropped code and a
// retired row is INACTIVE, so a second apply plans nothing, says so and writes
// nothing. Every UPDATE re-asserts the code it replaces, so a row changed in
// between fails the in-transaction count and rolls its pair back.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { PRODUCT_CODE_CASCADE } from "../src/scm/lib/product-code-rename.ts";
import { planDuplicateSkuMerge, confirmPhrase } from "./lib/duplicate-sku-merge-plan.mjs";
import { readMergeColumns, readMergeWorld, applyMerge, verifyMerge, rekeyIds } from "./lib/duplicate-sku-merge-run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const CONFIRM = process.env.CONFIRM ?? "";
const TICKET = (process.env.TICKET || "").trim();
const CO = Number(process.env.COMPANY_ID || 1);

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`); process.exit(2); }
const BOOK = JSON.parse(fs.readFileSync(path.join(HERE, "data", "duplicate-sku-merges.json"), "utf8"));
if (!BOOK[TICKET]) { console.error(`REFUSED: TICKET must be one of ${Object.keys(BOOK).join(", ")}, got "${TICKET}".`); process.exit(2); }
const PAIRS = BOOK[TICKET].pairs;

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);

/* The kept row is what every moved line prices and costs against from now on, so
   a difference is the thing to settle in SKU Master before the apply. Same /
   differs only: amounts stay out of this public log. */
const PRICE_FIELDS = ["base_price_sen", "sell_price_sen", "pwp_price_sen", "cost_price_sen", "price_matrix"];
function masterComparison(world, p) {
  const j = (code) => world.masters.find((m) => m.code === code)?.j ?? null;
  const drop = j(p.drop);
  const keep = j(p.keep);
  if (!drop || !keep) return [];
  const out = PRICE_FIELDS.filter((f) => f in keep || f in drop).map((f) => {
    const same = JSON.stringify(drop[f] ?? null) === JSON.stringify(keep[f] ?? null);
    const blank = keep[f] == null || keep[f] === 0;
    return `${f} ${same ? "same" : "DIFFERS"}${blank && !same ? " (kept code has none)" : ""}`;
  });
  const sup = (code) => world.mainSuppliers.filter((b) => b.item_code === code).map((b) => b.supplier ?? "?").sort().join("/") || "none";
  out.push(`main supplier: dropped ${sup(p.drop)}, kept ${sup(p.keep)}`);
  return out;
}

async function main() {
  log(`mode=${MODE} ticket=${TICKET} company=${CO}; ${PAIRS.length} pair(s)`);
  log(`ruling: ${BOOK[TICKET].ruling}`);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const cols = await readMergeColumns(sql, PRODUCT_CODE_CASCADE);
  const world = await readMergeWorld(sql, { co: CO, pairs: PAIRS, cascade: PRODUCT_CODE_CASCADE, cols });
  for (const m of world.missing) log(`   cascade column ${m} is not on this database - skipped`);

  const result = planDuplicateSkuMerge({
    pairs: PAIRS, products: world.products, refs: world.refs, stock: world.stock, stockTakeLines: world.stockTakeLines,
  });
  const idsOf = (p, r) => rekeyIds(world, p, r);

  log("");
  log("PER PAIR  (dropped code -> kept code)");
  for (const p of result.pairs) {
    const keepStock = world.stock.filter((s) => s.code === p.keep).map((s) => `${s.warehouseCode} ${s.ledgerQty}`);
    const dropStock = world.stock.filter((s) => s.code === p.drop).map((s) => `${s.warehouseCode} ${s.ledgerQty}`);
    log(`  "${p.drop}" -> "${p.keep}"`);
    log(`     dropped row: ${p.dropRowStatus ?? "not in the catalogue"}; stock on it ${dropStock.join(", ") || "none"}; on the kept code ${keepStock.join(", ") || "none"}`);
    log(`     SKU master: ${masterComparison(world, p).join("; ")}`);
    for (const r of p.rekey) log(`     re-key ${r.rows} row(s) in scm.${r.table}.${r.col}`);
    for (const r of p.stay) {
      const why = r.table === "stock_take_lines" ? "a closed or empty stock take line: the record of that count" : "catalogue-side, inert once the row is INACTIVE";
      log(`     stays  ${r.rows} row(s) in scm.${r.table}.${r.col} (${why})`);
    }
    if (p.retire) log("     then switch the dropped row off (INACTIVE)");
    for (const r of p.refusals) log(`     REFUSED: ${r}`);
  }
  const touched = new Set(result.pairs.flatMap((p) => p.rekey.map((r) => r.table)));
  for (const u of world.uniques.filter((x) => touched.has(x.tablename))) {
    log(`   unique index on a re-keyed table (a collision rolls its pair back): ${u.indexdef}`);
  }

  const t = result.totals;
  const phrase = confirmPhrase(t);
  log("");
  log(`TOTALS  pairs ${t.pairs}; refused ${t.refused}; re-key ${t.rowsToRekey} row(s); move ${t.unitsMoved} unit(s); retire ${t.toRetire} row(s)`);
  log(`to apply: MODE=apply CONFIRM="${phrase}"`);

  if (!APPLY) {
    log("PLAN ONLY - nothing was written.");
    await sql.end();
    return;
  }
  if (CONFIRM !== phrase) {
    log(`REFUSED: apply needs CONFIRM="${phrase}" - measured by this run. Nothing was written.`);
    await sql.end();
    process.exit(2);
  }
  const work = result.pairs.filter((p) => p.refusals.length === 0 && (p.rekey.length > 0 || p.retire));
  if (work.length === 0) {
    log("nothing to do - a re-run after a completed apply ends here.");
    await sql.end();
    return;
  }

  log("");
  log("UNDO  (before any write): each list below goes back with UPDATE scm.<table> SET <col> = '<dropped>' WHERE id::text = ANY(<ids>), and the row with status = 'ACTIVE'");
  for (const p of work) {
    for (const r of p.rekey) log(`   undo "${p.drop}" scm.${r.table}.${r.col}: ${JSON.stringify(idsOf(p, r))}`);
    if (p.retire) log(`   undo "${p.drop}" scm.mfg_products: ["${p.dropRowId}"]`);
  }

  const { committed, problems, rekeyed } = await applyMerge(sql, {
    co: CO, plan: result, world, cascade: PRODUCT_CODE_CASCADE, audit: null,
  });
  log(`WRITTEN: ${rekeyed} row(s) re-keyed, ${committed.filter((p) => p.retire).length} row(s) switched off; ${committed.length} of ${work.length} pair(s) committed`);
  await sql.end();

  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  problems.push(...await verifyMerge(v, { co: CO, committed, world }));
  for (const p of committed) {
    const keepStock = await v`
      SELECT w.code, SUM(CASE m.movement_type WHEN 'IN' THEN m.qty WHEN 'OUT' THEN -m.qty
                                              WHEN 'ADJUSTMENT' THEN m.qty WHEN 'TRANSFER' THEN m.qty ELSE 0 END)::int AS qty
        FROM scm.inventory_movements m JOIN scm.warehouses w ON w.id = m.warehouse_id
       WHERE m.company_id = ${CO} AND m.item_code = ${p.keep} GROUP BY w.code`;
    const [lines] = await v`SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND item_code = ${p.keep}`;
    log(`   VERIFY "${p.keep}": ${lines.n} sales-order line(s); stock ${keepStock.map((s) => `${s.code} ${s.qty}`).join(", ") || "none"}`);
  }
  await v.end();
  if (problems.length > 0) {
    for (const x of problems) log(`   VERIFY FAILED: ${x}`);
    log("FAILED. The UNDO lists above cover every write that landed.");
    process.exit(1);
  }
  log("VERIFIED on a fresh connection: every re-keyed row names its kept code, every dropped row is INACTIVE.");
  log("NEXT: run 'Recompute SO stock allocation (DRY-RUN gated)'. A direct SQL write does not recompute the allocation projection (docs/bugs/0675).");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://<redacted>"));
  process.exit(1);
});
