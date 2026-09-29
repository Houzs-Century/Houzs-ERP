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

async function readColumns(sql) {
  const rows = await sql`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ANY(${[...new Set(PRODUCT_CODE_CASCADE.map((c) => c.table))]})`;
  const cols = new Map();
  for (const r of rows) cols.set(r.table_name, (cols.get(r.table_name) ?? new Set()).add(r.column_name));
  return cols;
}

const kindClause = (sql, c) => (c.kind ? sql`AND material_kind::text = 'mfg_product'` : sql``);

async function readWorld(sql, cols) {
  const drops = PAIRS.map((p) => p.drop);
  const codes = [...drops, ...PAIRS.map((p) => p.keep)];

  const products = await sql`
    SELECT id::text AS id, code, status::text AS status, category::text AS category
      FROM scm.mfg_products WHERE company_id = ${CO} AND code = ANY(${codes})`;

  const refs = [];
  const ids = new Map();
  const missing = [];
  for (const c of PRODUCT_CODE_CASCADE) {
    const have = cols.get(c.table);
    if (!have?.has(c.col) || !have.has("company_id")) { missing.push(`${c.table}.${c.col}`); continue; }
    const hasId = have.has("id");
    const rows = await sql`
      SELECT ${sql(c.col)} AS code, ${hasId ? sql`id::text` : sql`NULL::text`} AS id
        FROM ${sql(`scm.${c.table}`)}
       WHERE company_id = ${CO} AND ${sql(c.col)} = ANY(${drops}) ${kindClause(sql, c)}`;
    for (const code of new Set(rows.map((r) => r.code))) {
      const mine = rows.filter((r) => r.code === code);
      refs.push({ table: c.table, col: c.col, code, rows: mine.length, hasId });
      ids.set(`${c.table}.${c.col}|${code}`, mine.map((r) => r.id));
    }
  }

  const warehouses = await sql`SELECT id::text AS id, code FROM scm.warehouses WHERE company_id = ${CO}`;
  const whCode = new Map(warehouses.map((w) => [w.id, String(w.code).toUpperCase()]));
  const whOf = (id) => (id == null ? "(NO WAREHOUSE)" : whCode.get(String(id)) ?? `(OTHER ${id})`);
  const ledger = await sql`
    SELECT item_code, warehouse_id::text AS warehouse_id,
           SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                  WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::int AS qty
      FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ANY(${codes})
     GROUP BY item_code, warehouse_id`;
  const lots = await sql`
    SELECT item_code, warehouse_id::text AS warehouse_id, SUM(qty_remaining)::int AS qty
      FROM scm.inventory_lots WHERE company_id = ${CO} AND item_code = ANY(${codes}) AND qty_remaining <> 0
     GROUP BY item_code, warehouse_id`;
  const stockMap = new Map();
  const cell = (code, wh) => {
    const k = `${code}|${wh}`;
    if (!stockMap.has(k)) stockMap.set(k, { code, warehouseCode: whOf(wh), ledgerQty: 0, lotQty: 0 });
    return stockMap.get(k);
  };
  for (const r of ledger) cell(r.item_code, r.warehouse_id).ledgerQty += Number(r.qty);
  for (const r of lots) cell(r.item_code, r.warehouse_id).lotQty += Number(r.qty);
  const stock = [...stockMap.values()].filter((s) => s.ledgerQty !== 0 || s.lotQty !== 0);

  const uniques = await sql`
    SELECT tablename, indexdef FROM pg_indexes
     WHERE schemaname = 'scm' AND indexdef ILIKE 'CREATE UNIQUE%'
       AND tablename = ANY(${[...new Set(refs.map((r) => r.table))]})`;

  const masters = await sql`
    SELECT code, to_jsonb(p) AS j FROM scm.mfg_products p WHERE company_id = ${CO} AND code = ANY(${codes})`;
  const mainSuppliers = await sql`
    SELECT b.item_code, s.code AS supplier
      FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.company_id = ${CO} AND b.item_code = ANY(${codes})
       AND b.material_kind::text = 'mfg_product' AND b.is_main_supplier = true`;

  return { products, refs, ids, missing, stock, uniques, masters, mainSuppliers };
}

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
  const cols = await readColumns(sql);
  const world = await readWorld(sql, cols);
  for (const m of world.missing) log(`   cascade column ${m} is not on this database - skipped`);

  const result = planDuplicateSkuMerge({ pairs: PAIRS, products: world.products, refs: world.refs, stock: world.stock });

  log("");
  log("PER PAIR  (dropped code -> kept code)");
  for (const p of result.pairs) {
    const keepStock = world.stock.filter((s) => s.code === p.keep).map((s) => `${s.warehouseCode} ${s.ledgerQty}`);
    const dropStock = world.stock.filter((s) => s.code === p.drop).map((s) => `${s.warehouseCode} ${s.ledgerQty}`);
    log(`  "${p.drop}" -> "${p.keep}"`);
    log(`     dropped row: ${p.dropRowStatus ?? "not in the catalogue"}; stock on it ${dropStock.join(", ") || "none"}; on the kept code ${keepStock.join(", ") || "none"}`);
    log(`     SKU master: ${masterComparison(world, p).join("; ")}`);
    for (const r of p.rekey) log(`     re-key ${r.rows} row(s) in scm.${r.table}.${r.col}`);
    for (const r of p.stay) log(`     stays  ${r.rows} row(s) in scm.${r.table}.${r.col} (catalogue-side, inert once the row is INACTIVE)`);
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
    for (const r of p.rekey) log(`   undo "${p.drop}" scm.${r.table}.${r.col}: ${JSON.stringify(world.ids.get(`${r.table}.${r.col}|${p.drop}`))}`);
    if (p.retire) log(`   undo "${p.drop}" scm.mfg_products: ["${p.dropRowId}"]`);
  }

  const committed = [];
  const problems = [];
  let rekeyed = 0;
  for (const p of work) {
    try {
      let n = 0;
      await sql.begin(async (tx) => {
        for (const r of p.rekey) {
          const c = PRODUCT_CODE_CASCADE.find((x) => x.table === r.table && x.col === r.col);
          const ids = world.ids.get(`${r.table}.${r.col}|${p.drop}`);
          const done = await tx`
            UPDATE ${tx(`scm.${r.table}`)} SET ${tx(r.col)} = ${p.keep}
             WHERE company_id = ${CO} AND ${tx(r.col)} = ${p.drop} AND id::text = ANY(${ids}) ${kindClause(tx, c)}
            RETURNING id`;
          if (done.length !== ids.length) throw new Error(`scm.${r.table}: re-keyed ${done.length} of ${ids.length} - a row changed since the plan`);
          const [left] = await tx`
            SELECT COUNT(*)::int AS n FROM ${tx(`scm.${r.table}`)}
             WHERE company_id = ${CO} AND ${tx(r.col)} = ${p.drop} ${kindClause(tx, c)}`;
          if (left.n !== 0) throw new Error(`scm.${r.table}: ${left.n} row(s) still carry "${p.drop}" after the re-key`);
          n += done.length;
        }
        if (p.retire) {
          const [stock] = await tx`
            SELECT COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                  WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END), 0)::int AS qty,
                   (SELECT COUNT(*)::int FROM scm.inventory_lots
                     WHERE company_id = ${CO} AND item_code = ${p.drop} AND qty_remaining <> 0) AS open_lots
              FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ${p.drop}`;
          if (stock.qty !== 0 || stock.open_lots !== 0) throw new Error(`"${p.drop}" still holds stock ${stock.qty} / open lots ${stock.open_lots}, so not switched off`);
          const off = await tx`
            UPDATE scm.mfg_products SET status = 'INACTIVE', updated_at = now()
             WHERE company_id = ${CO} AND id::text = ${p.dropRowId} AND code = ${p.drop} AND status = 'ACTIVE'
            RETURNING id`;
          if (off.length !== 1) throw new Error("the dropped catalogue row was not ACTIVE any more");
        }
      });
      committed.push(p);
      rekeyed += n;
    } catch (e) {
      problems.push(`"${p.drop}" ROLLED BACK, nothing of it was written: ${String(e?.message ?? e)}`);
    }
  }
  log(`WRITTEN: ${rekeyed} row(s) re-keyed, ${committed.filter((p) => p.retire).length} row(s) switched off; ${committed.length} of ${work.length} pair(s) committed`);
  await sql.end();

  /* ---- verification on a connection this run has not used, asserting what the
     rows now SAY, not how many were touched ----------------------------------- */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  for (const p of committed) {
    for (const r of p.rekey) {
      const ids = world.ids.get(`${r.table}.${r.col}|${p.drop}`);
      const rows = await v`SELECT id::text AS id, ${v(r.col)} AS code FROM ${v(`scm.${r.table}`)} WHERE id::text = ANY(${ids})`;
      for (const row of rows) if (row.code !== p.keep) problems.push(`scm.${r.table} ${row.id} carries "${row.code}", wanted "${p.keep}"`);
      if (rows.length !== ids.length) problems.push(`scm.${r.table}: ${ids.length - rows.length} re-keyed row(s) are gone`);
    }
    const [row] = await v`SELECT code, status::text AS status FROM scm.mfg_products WHERE id::text = ${p.dropRowId}`;
    if (p.retire && row?.status !== "INACTIVE") problems.push(`"${p.drop}" is ${row?.status ?? "gone"}, wanted INACTIVE`);
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
