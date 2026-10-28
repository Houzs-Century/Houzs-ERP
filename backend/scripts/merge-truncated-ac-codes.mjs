#!/usr/bin/env node
// Merge the AutoCount codes cut at 30 characters into the ERP codes the mapping
// sheet names. PLAN BY DEFAULT: nothing is written unless MODE=apply, PART and
// CONFIRM all say so.
//
// THE OWNER'S REPORT, 2026-09-14: "DL-CS2 NN-WINTER SLEEP MATT (K) autocount
// shown have 2pcs. ERP shown 0. Physical qty is 2pcs for king". The read-only
// "Duplicate item-code impact" runs that day proved one mattress under two
// catalogue codes: its 2 units on the long name, its 6 sales-order lines on the
// book's truncated code. The trace is in docs/bugs/0890; the rules live once, in
// lib/truncated-code-merge-plan.mjs.
//
// THE OWNER'S RULING, same day: keep the mapping sheet's name, move the lines,
// switch the truncated rows off, take the double-counted units out.
//
// TWO PARTS, chosen with PART:
//   lines     re-key the sales-order lines (item_code only) and switch off the
//             truncated rows that hold no stock. No quantity and no money moves.
//   writeoff  one negative ADJUSTMENT per double-counted lot, at the lot's own
//             warehouse, item, variant key and batch, so the FIFO trigger
//             consumes that lot and stamps its cost on the movement; then switch
//             those rows off. This takes the lots' cost out of inventory value -
//             the plan prints the total, and that figure is the decision.
//
// WHAT IT NEVER TOUCHES: a line's description, qty, price or variants; the
// survivor's stock; the stock history on the truncated code (it nets to zero and
// stays readable there); supplier bindings and price history on the truncated
// code, inert once no line carries it; AutoCount - a raw SQL change queues no
// write-back, and the book already holds its own code on these lines.
//
// OUTPUT: counts and product codes to the log, because this repository and its
// Actions logs are public. Document numbers, lot ids and costs go to OUT_DIR,
// uploaded as a build artifact: plan.json on every run, and before any write a
// restore.json that is read back from disk before the write may start.
//
//   DATABASE_URL  required
//   MODE          plan (default, writes nothing) | apply
//   PART          lines | writeoff - apply only
//   CONFIRM       on apply, the phrase this run prints for that part; it carries
//                 the counts this run measured, so a phrase copied from an older
//                 run cannot fire
//   COMPANY_ID    default 1
//   OUT_DIR       default ./merge-truncated-ac-codes-out
//
// RE-RUN: convergent. A re-keyed line no longer carries the truncated code, a
// written-off lot is empty and a retired row is INACTIVE, so a second apply of
// the same part plans nothing, says so and writes nothing. Every UPDATE
// re-asserts the value it replaces, so a row a person changed in between is
// left alone and fails the in-transaction check instead of being overwritten.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { readMappingCsv, normCode } from "./lib/ac-mapping-csv.mjs";
import { SALESLOC } from "./lib/ac-stock-compare.mjs";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";
import {
  truncatedPairs,
  duplicateCatalogueRows,
  planTruncatedCodeMerge,
} from "./lib/truncated-code-merge-plan.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");

const DST = process.env.DATABASE_URL;
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const PART = (process.env.PART || "").toLowerCase();
const CONFIRM = process.env.CONFIRM ?? "";
const CO = Number(process.env.COMPANY_ID || 1);
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), "merge-truncated-ac-codes-out");
const MOVEMENT_DOC_NO = "TRUNC-CODE-MERGE-2026-09-14";

if (!DST) { console.error("REFUSED: DATABASE_URL not set."); process.exit(2); }
if (!["plan", "apply"].includes(MODE)) { console.error(`REFUSED: MODE must be plan or apply, got "${MODE}".`); process.exit(2); }
if (APPLY && !["lines", "writeoff"].includes(PART)) {
  console.error(`REFUSED: MODE=apply needs PART=lines or PART=writeoff, got "${PART}".`);
  process.exit(2);
}

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;
const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/* Tables keyed by item code that are NOT documents: the stock ledger (judged
   through balances and lots instead), and catalogue-side rows that go inert with
   the product. Every other base table carrying an item_code is a document, and a
   document on the truncated code refuses its pair. */
const NOT_DOCUMENTS = new Set([
  "mfg_sales_order_items",
  "inventory_movements", "inventory_lots", "inventory_lot_consumptions",
  "supplier_material_bindings", "master_price_history", "mfg_product_price_history", "product_dept_configs",
]);

function readBook() {
  const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, f))).toString("utf8").replace(/^﻿/, ""));
  const mapping = readMappingCsv(fs.readFileSync(path.join(DATA, "autocount-erp-mapping-1561.csv"), "utf8"));
  const items = gz("ac-live-item-master.json.gz").map((r) => r.ItemCode);
  const balance = gz("ac-stock-balance-2026-09-10.json.gz");
  /* as_at is written in Malaysia time with no offset. */
  const snapshotAt = new Date(`${String(balance.as_at).replace(" ", "T")}+08:00`).toISOString();
  const acBalance = new Map();
  for (const cell of balance.cells) {
    const erp = mapping.get(normCode(cell.item))?.erp;
    if (!erp) continue;
    const loc = normCode(cell.location);
    const key = `${normCode(erp)}|${String(SALESLOC[loc] ?? loc).toUpperCase()}`;
    acBalance.set(key, (acBalance.get(key) ?? 0) + Number(cell.bal_qty ?? 0));
  }
  return { mapping, items, snapshotAt, bookName: balance.book, acBalance };
}

async function readWorld(sql, pairs) {
  const truncCodes = pairs.map((p) => p.acCode);
  const allCodes = [...truncCodes, ...pairs.map((p) => p.survivorCode)];

  const warehouses = await sql`SELECT id::text AS id, code FROM scm.warehouses WHERE company_id = ${CO}`;
  const whCode = new Map(warehouses.map((w) => [w.id, String(w.code).toUpperCase()]));
  const whOf = (id) => (id == null ? "(NO WAREHOUSE)" : whCode.get(String(id)) ?? `(OTHER ${id})`);

  const products = await sql`
    SELECT id::text AS id, code, name, status::text AS status, category::text AS category
      FROM scm.mfg_products WHERE company_id = ${CO}`;

  const soLines = await sql`
    SELECT s.id::text AS id, s.doc_no, s.item_code, s.item_group, s.variants, s.qty::int AS qty,
           s.cancelled, s.linked_ac_dtlkey::text AS dtlkey, h.status::text AS so_status
      FROM scm.mfg_sales_order_items s
      JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
     WHERE s.company_id = ${CO} AND s.item_code = ANY(${truncCodes})
     ORDER BY s.doc_no, s.id`;

  /* A line whose code differs from a truncated code only by case or spacing is
     the same defect written differently. It is not in the exact-match plan, so it
     is surfaced and refuses its pair rather than being silently left behind. */
  const nearMiss = await sql`
    SELECT item_code, COUNT(*)::int AS n
      FROM scm.mfg_sales_order_items
     WHERE company_id = ${CO}
       AND UPPER(REGEXP_REPLACE(BTRIM(item_code), '\\s+', ' ', 'g')) = ANY(${truncCodes.map(normCode)})
       AND item_code <> ALL(${truncCodes})
     GROUP BY item_code`;

  const tables = await sql`
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'scm' AND c.column_name = 'item_code' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name`;
  const otherRefs = [];
  for (const { table_name: table } of tables) {
    if (NOT_DOCUMENTS.has(table)) continue;
    const rows = await sql`
      SELECT item_code, COUNT(*)::int AS n FROM ${sql(`scm.${table}`)}
       WHERE item_code = ANY(${truncCodes}) GROUP BY item_code`;
    for (const r of rows) otherRefs.push({ itemCode: r.item_code, table, rows: r.n });
  }
  for (const r of nearMiss) {
    const trunc = truncCodes.find((c) => normCode(c) === normCode(r.item_code));
    otherRefs.push({ itemCode: trunc, table: "mfg_sales_order_items (spelled differently)", rows: r.n });
  }

  /* Signed exactly as the scm.inventory_balances view signs them. */
  const balanceRows = await sql`
    SELECT item_code, warehouse_id::text AS warehouse_id, variant_key,
           SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                  WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::int AS qty,
           COUNT(*)::int AS movements, MAX(created_at) AS last_at
      FROM scm.inventory_movements
     WHERE company_id = ${CO} AND item_code = ANY(${allCodes})
     GROUP BY item_code, warehouse_id, variant_key`;

  const lotRows = await sql`
    SELECT id::text AS id, item_code, warehouse_id::text AS warehouse_id, variant_key, batch_no,
           product_name, qty_remaining::int AS qty_remaining, unit_cost_sen::bigint AS unit_cost_sen,
           source_doc_type, source_doc_no, received_at
      FROM scm.inventory_lots
     WHERE company_id = ${CO} AND item_code = ANY(${allCodes}) AND qty_remaining <> 0
     ORDER BY received_at, id`;

  const bindings = await sql`
    SELECT b.item_code, b.supplier_sku, b.is_main_supplier, s.code AS supplier_code
      FROM scm.supplier_material_bindings b
      LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
     WHERE b.company_id = ${CO} AND b.item_code = ANY(${allCodes})
     ORDER BY b.item_code, b.is_main_supplier DESC`;

  return {
    products: products.map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, category: p.category })),
    soLines,
    otherRefs,
    balances: balanceRows.map((b) => ({
      itemCode: b.item_code, warehouseCode: whOf(b.warehouse_id), variantKey: b.variant_key,
      qty: Number(b.qty), movements: Number(b.movements), lastMovementAt: iso(b.last_at),
    })),
    lots: lotRows.map((l) => ({
      id: l.id, itemCode: l.item_code, warehouseCode: whOf(l.warehouse_id), warehouseId: l.warehouse_id,
      variantKey: l.variant_key, batchNo: l.batch_no, productName: l.product_name,
      qtyRemaining: Number(l.qty_remaining), unitCostSen: Number(l.unit_cost_sen ?? 0),
      sourceDocType: l.source_doc_type, sourceDocNo: l.source_doc_no, receivedAt: l.received_at ? iso(l.received_at) : null,
    })),
    bindings,
  };
}

function phraseFor(part, totals) {
  return part === "lines"
    ? `REKEY ${totals.linesToRekey} LINES AND RETIRE ${totals.retireInLines} ROWS`
    : `WRITE OFF ${totals.unitsToWriteOff} UNITS (${rm(totals.writeOffValueSen)}) AND RETIRE ${totals.retireInWriteoff} ROWS`;
}

function writeAndReadBack(file, obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, file);
  fs.writeFileSync(target, JSON.stringify(obj, null, 2), "utf8");
  return { target, back: JSON.parse(fs.readFileSync(target, "utf8")) };
}

async function main() {
  const book = readBook();
  const { pairs, unmapped } = truncatedPairs(book.items, book.mapping);
  log(`mode=${MODE}${APPLY ? ` part=${PART}` : ""} company=${CO}`);
  log(`book: ${book.bookName} balance as at ${book.snapshotAt}; ${book.items.length} item codes; ${pairs.length} truncated at the 30-character cap and mapped, ${unmapped.length} truncated and unmapped`);
  for (const u of unmapped) log(`   UNMAPPED truncated code "${u}" - the mapping sheet names no ERP code, so there is nothing to merge it into`);

  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const world = await readWorld(sql, pairs);
  const result = planTruncatedCodeMerge({
    pairs,
    products: world.products,
    soLines: world.soLines.map((l) => ({ id: l.id, docNo: l.doc_no, itemCode: l.item_code, itemGroup: l.item_group })),
    otherRefs: world.otherRefs,
    balances: world.balances,
    lots: world.lots,
    acBalance: book.acBalance,
    snapshotAt: book.snapshotAt,
  });

  const lineById = new Map(world.soLines.map((l) => [l.id, l]));
  const lotById = new Map(world.lots.map((l) => [l.id, l]));
  const survivorLotKeys = (code) => [...new Set(world.lots.filter((l) => normCode(l.itemCode) === normCode(code)).map((l) => l.variantKey ?? "(null)"))];

  log("");
  log("PER PAIR  (truncated book code -> the name the mapping sheet keeps)");
  for (const p of result.pairs) {
    const survQty = world.balances.filter((b) => normCode(b.itemCode) === normCode(p.survivorCode)).reduce((s, b) => s + b.qty, 0);
    const truncQty = world.balances.filter((b) => normCode(b.itemCode) === normCode(p.acCode)).reduce((s, b) => s + b.qty, 0);
    log(`  "${p.acCode}" -> "${p.survivorCode}"`);
    log(`     truncated row: ${p.bookRowStatus ?? "not in the catalogue"}; stock on it ${truncQty}; on the survivor ${survQty}`);
    log(`     lines to re-key: ${p.rekey.length}; units to write off: ${p.writeOffs.reduce((s, x) => s + x.qty, 0)}; switched off in part ${p.retireInLines ? "lines" : p.retireInWriteoff ? "writeoff" : "(neither)"}`);
    const lineKeys = [...new Set(p.rekey.map((x) => {
      const l = lineById.get(x.id);
      return variantKeyMirror(l?.item_group, l?.variants ?? null);
    }))];
    if (p.rekey.length > 0) {
      const stockKeys = survivorLotKeys(p.survivorCode);
      const unmatched = lineKeys.filter((k) => stockKeys.length > 0 && !stockKeys.includes(k));
      log(`     line variant keys ${JSON.stringify(lineKeys)}; survivor stock keys ${JSON.stringify(stockKeys)}${unmatched.length ? "  <- a line key the stock does not carry: allocation still cannot match it" : ""}`);
    }
    for (const r of p.refusals) log(`     REFUSED: ${r}`);
  }

  const census = duplicateCatalogueRows(book.mapping, world.products);
  const notTruncated = census.filter((c) => !c.truncated);
  log("");
  log(`ONE PRODUCT UNDER TWO CATALOGUE CODES, whole catalogue (report only): ${census.length} pair(s), ${census.length - notTruncated.length} of them truncated codes`);
  if (notTruncated.length > 0) {
    const codes = notTruncated.flatMap((c) => [c.bookCode, c.survivorCode]);
    const demand = await sql`
      SELECT s.item_code, COUNT(*)::int AS n
        FROM scm.mfg_sales_order_items s
        JOIN scm.mfg_sales_orders h ON h.doc_no = s.doc_no
       WHERE s.company_id = ${CO} AND s.item_code = ANY(${codes}) AND COALESCE(s.cancelled, false) = false
         AND h.status::text NOT IN ('DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED')
       GROUP BY s.item_code`;
    const stock = await sql`
      SELECT item_code, SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                               WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END)::int AS qty
        FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ANY(${codes}) GROUP BY item_code`;
    const d = new Map(demand.map((r) => [r.item_code, r.n]));
    const s = new Map(stock.map((r) => [r.item_code, r.qty]));
    for (const c of notTruncated) {
      c.bookOpenLines = d.get(c.bookCode) ?? 0; c.bookStock = s.get(c.bookCode) ?? 0;
      c.survivorOpenLines = d.get(c.survivorCode) ?? 0; c.survivorStock = s.get(c.survivorCode) ?? 0;
      c.split = (c.bookOpenLines > 0 && c.bookStock <= 0 && c.survivorStock > 0)
        || (c.survivorOpenLines > 0 && c.survivorStock <= 0 && c.bookStock > 0);
    }
    log(`   not truncated: ${notTruncated.length}; open sales-order lines on the book-coded row: ${notTruncated.filter((c) => c.bookOpenLines > 0).length}; stock on the book-coded row: ${notTruncated.filter((c) => c.bookStock !== 0).length}; demand on one code with the stock on the other: ${notTruncated.filter((c) => c.split).length}`);
    for (const c of notTruncated.filter((x) => x.split)) log(`   SPLIT "${c.bookCode}" (lines ${c.bookOpenLines}, stock ${c.bookStock}) / "${c.survivorCode}" (lines ${c.survivorOpenLines}, stock ${c.survivorStock})`);
  }

  const t = result.totals;
  const acting = result.pairs.filter((p) => p.refusals.length === 0);
  log("");
  log(`TOTALS  pairs ${t.pairs}; refused ${t.refused}`);
  log(`   part lines     re-key ${t.linesToRekey} sales-order line(s) on ${new Set(acting.flatMap((p) => p.rekey.map((x) => x.docNo))).size} order(s); switch off ${t.retireInLines} row(s)`);
  log(`   part writeoff  write off ${t.unitsToWriteOff} unit(s), taking ${rm(t.writeOffValueSen)} out of inventory value; switch off ${t.retireInWriteoff} row(s)`);

  const planDoc = {
    measuredAt: new Date().toISOString(),
    companyId: CO,
    book: { name: book.bookName, balanceAsAt: book.snapshotAt },
    unmapped,
    totals: t,
    pairs: result.pairs.map((p) => ({
      ...p,
      rekey: p.rekey.map((x) => {
        const l = lineById.get(x.id);
        return { ...x, soStatus: l?.so_status, qty: l?.qty, cancelled: l?.cancelled, linkedAcDtlkey: l?.dtlkey, itemGroup: l?.item_group };
      }),
      writeOffs: p.writeOffs.map((x) => ({ ...x, sourceDocType: lotById.get(x.lotId)?.sourceDocType, sourceDocNo: lotById.get(x.lotId)?.sourceDocNo })),
    })),
    otherRefs: world.otherRefs,
    bindings: world.bindings,
    balances: world.balances,
    lots: world.lots,
    census,
    phrases: { lines: phraseFor("lines", t), writeoff: phraseFor("writeoff", t) },
  };
  const { target: planPath } = writeAndReadBack("plan.json", planDoc);
  log(`plan written to ${planPath} (document numbers, lot ids and costs are there, not in this log)`);
  log(`to apply part lines:    MODE=apply PART=lines CONFIRM="${planDoc.phrases.lines}"`);
  log(`to apply part writeoff: MODE=apply PART=writeoff CONFIRM="${planDoc.phrases.writeoff}"`);

  if (!APPLY) {
    log("PLAN ONLY - nothing was written.");
    await sql.end();
    return;
  }

  const phrase = planDoc.phrases[PART];
  if (CONFIRM !== phrase) {
    log(`REFUSED: PART=${PART} needs CONFIRM="${phrase}" - measured by this run. Nothing was written.`);
    await sql.end();
    process.exit(2);
  }
  const work = acting.filter((p) => (PART === "lines"
    ? p.rekey.length > 0 || p.retireInLines
    : p.writeOffs.length > 0 || p.retireInWriteoff));
  if (work.length === 0) {
    log(`nothing to do for part ${PART} - a re-run after a completed apply ends here.`);
    await sql.end();
    return;
  }

  const restore = {
    dumpedAt: new Date().toISOString(),
    part: PART,
    database: "the DATABASE_URL this run was given",
    ruling: "owner 2026-09-14: keep the mapping sheet's name, move the lines, switch the truncated rows off, take the double-counted units out",
    lines: work.flatMap((p) => p.rekey.map((x) => ({ id: x.id, docNo: x.docNo, from: p.acCode, to: p.survivorCode,
      undo: `UPDATE scm.mfg_sales_order_items SET item_code = '${p.acCode.replace(/'/g, "''")}' WHERE id::text = '${x.id}' AND item_code = '${p.survivorCode.replace(/'/g, "''")}';` }))),
    writeOffs: PART === "writeoff" ? work.flatMap((p) => p.writeOffs.map((x) => ({ ...x,
      undo: `a positive ADJUSTMENT of ${x.qty} on "${x.itemCode}" at ${x.warehouseCode}, variant key "${x.variantKey}", unit_cost_sen ${x.unitCostSen}` }))) : [],
    retire: work.filter((p) => (PART === "lines" ? p.retireInLines : p.retireInWriteoff)).map((p) => ({ id: p.bookRowId, code: p.acCode,
      undo: `UPDATE scm.mfg_products SET status = 'ACTIVE' WHERE id::text = '${p.bookRowId}' AND status = 'INACTIVE';` })),
  };
  const { target: restorePath, back } = writeAndReadBack("restore.json", restore);
  const restoreOk = back.lines.length === restore.lines.length
    && back.writeOffs.length === restore.writeOffs.length
    && back.retire.length === restore.retire.length
    && back.retire.every((r) => r.id);
  log(`restore dump written to ${restorePath} and re-read: ${restoreOk ? "OK" : "FAILED"}`);
  if (!restoreOk) {
    log("REFUSED: the restore dump did not read back. Nothing was written.");
    await sql.end();
    process.exit(1);
  }

  const mvCols = new Set((await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = 'inventory_movements'`).map((r) => r.column_name));

  const [{ started }] = await sql`SELECT now() AS started`;
  let rekeyed = 0, retired = 0, writtenOff = 0;
  const committed = [];
  const problems = [];
  for (const p of work) {
    const did = { lines: 0, units: 0, retired: 0 };
    try {
      await sql.begin(async (tx) => {
        if (PART === "lines" && p.rekey.length > 0) {
          const ids = p.rekey.map((x) => x.id);
          const done = await tx`
            UPDATE scm.mfg_sales_order_items SET item_code = ${p.survivorCode}
             WHERE company_id = ${CO} AND id::text = ANY(${ids}) AND item_code = ${p.acCode}
            RETURNING id`;
          if (done.length !== ids.length) throw new Error(`re-keyed ${done.length} of ${ids.length} lines - a line changed since the plan`);
          const [left] = await tx`SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND item_code = ${p.acCode}`;
          if (left.n !== 0) throw new Error(`${left.n} line(s) still carry the truncated code after the re-key`);
          did.lines = done.length;
        }

        if (PART === "writeoff") {
          for (const x of p.writeOffs) {
            const lot = lotById.get(x.lotId);
            const [now] = await tx`SELECT qty_remaining::int AS q FROM scm.inventory_lots WHERE id::text = ${x.lotId} FOR UPDATE`;
            if (!now || now.q !== x.qty) throw new Error(`lot ${x.lotId} holds ${now?.q ?? "nothing"}, the plan read ${x.qty}`);
            const cols = ["movement_type", "warehouse_id", "item_code", "variant_key", "qty", "unit_cost_sen", "source_doc_type", "source_doc_no"];
            const vals = ["'ADJUSTMENT'", "$1", "$2", "$3", "$4", "0", "'ADJUSTMENT'", "$5"];
            const params = [lot.warehouseId, x.itemCode, x.variantKey, -x.qty, MOVEMENT_DOC_NO];
            const add = (col, value) => { if (mvCols.has(col)) { cols.push(col); params.push(value); vals.push(`$${params.length}`); } };
            if (x.batchNo != null) add("batch_no", x.batchNo);
            add("product_name", lot.productName ?? null);
            add("reason_code", "COUNT");
            add("notes", `Counted twice: "${x.itemCode}" is AutoCount's 30-character cut of "${p.survivorCode}", which already holds AutoCount's balance at ${x.warehouseCode}. Owner 2026-09-14. docs/bugs/0890`);
            add("company_id", CO);
            await tx.unsafe(`INSERT INTO scm.inventory_movements (${cols.join(",")}) VALUES (${vals.join(",")})`, params);
            did.units += x.qty;
          }
          const lotIds = p.writeOffs.map((x) => x.lotId);
          if (lotIds.length > 0) {
            const [open] = await tx`SELECT COUNT(*)::int AS n FROM scm.inventory_lots WHERE id::text = ANY(${lotIds}) AND qty_remaining <> 0`;
            if (open.n !== 0) throw new Error(`${open.n} planned lot(s) still open after the write-off`);
          }
        }

        if (PART === "lines" ? p.retireInLines : p.retireInWriteoff) {
          const [stock] = await tx`
            SELECT COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                                   WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END), 0)::int AS qty,
                   (SELECT COUNT(*)::int FROM scm.inventory_lots
                     WHERE company_id = ${CO} AND item_code = ${p.acCode} AND qty_remaining <> 0) AS open_lots
              FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ${p.acCode}`;
          const [lines] = await tx`SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND item_code = ${p.acCode}`;
          if (stock.qty !== 0 || stock.open_lots !== 0 || lines.n !== 0) {
            throw new Error(`not empty (stock ${stock.qty}, open lots ${stock.open_lots}, lines ${lines.n}), so not switched off`);
          }
          const off = await tx`
            UPDATE scm.mfg_products SET status = 'INACTIVE', updated_at = now()
             WHERE company_id = ${CO} AND id::text = ${p.bookRowId} AND code = ${p.acCode} AND status = 'ACTIVE'
            RETURNING id`;
          if (off.length !== 1) throw new Error("the catalogue row was not ACTIVE any more");
          did.retired = 1;
        }
      });
      committed.push(p);
      rekeyed += did.lines; writtenOff += did.units; retired += did.retired;
    } catch (e) {
      problems.push(`"${p.acCode}" ROLLED BACK, nothing of it was written: ${String(e?.message ?? e)}`);
    }
  }
  log(`WRITTEN: ${rekeyed} line(s) re-keyed, ${writtenOff} unit(s) written off, ${retired} row(s) switched off; ${committed.length} of ${work.length} pair(s) committed`);
  await sql.end();

  /* ---- verification on a connection this run has not used, asserting what the
     rows now SAY, not how many were touched ----------------------------------- */
  const v = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const done = new Set(committed.map((p) => p.acCode));
  const doneLines = restore.lines.filter((x) => done.has(x.from));
  const doneWriteOffs = restore.writeOffs.filter((x) => done.has(x.itemCode));
  const doneRetire = restore.retire.filter((r) => done.has(r.code));

  if (doneLines.length > 0) {
    const rows = await v`SELECT id::text AS id, item_code FROM scm.mfg_sales_order_items WHERE id::text = ANY(${doneLines.map((x) => x.id)})`;
    const want = new Map(doneLines.map((x) => [x.id, x.to]));
    for (const r of rows) if (r.item_code !== want.get(r.id)) problems.push(`line ${r.id} carries "${r.item_code}", wanted "${want.get(r.id)}"`);
    if (rows.length !== doneLines.length) problems.push(`${doneLines.length - rows.length} re-keyed line(s) are gone`);
  }

  if (doneWriteOffs.length > 0) {
    const lots = await v`SELECT id::text AS id, qty_remaining::int AS q FROM scm.inventory_lots WHERE id::text = ANY(${doneWriteOffs.map((x) => x.lotId)})`;
    for (const l of lots) if (l.q !== 0) problems.push(`lot ${l.id} still holds ${l.q}`);
    const moves = await v`
      SELECT qty::int AS qty, total_cost_sen::bigint AS cost
        FROM scm.inventory_movements
       WHERE company_id = ${CO} AND source_doc_no = ${MOVEMENT_DOC_NO} AND created_at >= ${started}
         AND item_code = ANY(${[...new Set(doneWriteOffs.map((x) => x.itemCode))]})`;
    const wantUnits = doneWriteOffs.reduce((s, x) => s + x.qty, 0);
    const wantCost = doneWriteOffs.reduce((s, x) => s + x.qty * x.unitCostSen, 0);
    const gotUnits = -moves.reduce((s, m) => s + m.qty, 0);
    const gotCost = moves.reduce((s, m) => s + Number(m.cost), 0);
    if (gotUnits !== wantUnits) problems.push(`write-off movements total ${gotUnits} unit(s), planned ${wantUnits}`);
    if (gotCost !== wantCost) problems.push(`write-off movements carry ${rm(gotCost)} of cost, planned ${rm(wantCost)} - the FIFO trigger did not consume the lots the plan named`);
  }

  if (doneRetire.length > 0) {
    const rows = await v`SELECT id::text AS id, code, status::text AS status FROM scm.mfg_products WHERE id::text = ANY(${doneRetire.map((r) => r.id)})`;
    for (const r of rows) if (r.status !== "INACTIVE" || !done.has(r.code)) problems.push(`catalogue row "${r.code}" is ${r.status}`);
    if (rows.length !== doneRetire.length) problems.push(`${doneRetire.length - rows.length} retired catalogue row(s) are gone`);
  }

  for (const p of committed) {
    const [truncated] = await v`
      SELECT COALESCE(SUM(CASE movement_type WHEN 'IN' THEN qty WHEN 'OUT' THEN -qty
                                             WHEN 'ADJUSTMENT' THEN qty WHEN 'TRANSFER' THEN qty ELSE 0 END), 0)::int AS qty
        FROM scm.inventory_movements WHERE company_id = ${CO} AND item_code = ${p.acCode}`;
    const survivor = await v`
      SELECT w.code, SUM(CASE m.movement_type WHEN 'IN' THEN m.qty WHEN 'OUT' THEN -m.qty
                                              WHEN 'ADJUSTMENT' THEN m.qty WHEN 'TRANSFER' THEN m.qty ELSE 0 END)::int AS qty
        FROM scm.inventory_movements m JOIN scm.warehouses w ON w.id = m.warehouse_id
       WHERE m.company_id = ${CO} AND m.item_code = ${p.survivorCode}
       GROUP BY w.code`;
    const onSurvivor = await v`SELECT COUNT(*)::int AS n FROM scm.mfg_sales_order_items WHERE company_id = ${CO} AND item_code = ${p.survivorCode}`;
    const byWh = survivor.map((s) => {
      const bookQty = book.acBalance.get(`${normCode(p.survivorCode)}|${String(s.code).toUpperCase()}`) ?? 0;
      return `${s.code} ${s.qty} (AutoCount ${bookQty})${s.qty === bookQty ? "" : " <- differs"}`;
    });
    log(`   VERIFY "${p.survivorCode}": ${onSurvivor[0].n} sales-order line(s); stock ${byWh.join(", ") || "none"}; truncated code now ${truncated.qty}`);
    if (PART === "writeoff" && truncated.qty !== 0) problems.push(`"${p.acCode}" still holds ${truncated.qty} after the write-off`);
  }
  await v.end();

  if (problems.length > 0) {
    for (const x of problems) log(`   VERIFY FAILED: ${x}`);
    log(`FAILED on a fresh connection. ${restorePath} holds the undo for every write that landed.`);
    process.exit(1);
  }
  log(`VERIFIED on a fresh connection: every re-keyed line names its survivor, every written-off lot is empty, every retired row is INACTIVE.`);
  log("NEXT: run 'Recompute SO stock allocation (DRY-RUN gated)' for the orders in plan.json. A direct SQL write does not recompute the allocation projection (docs/bugs/0675).");
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "postgres://<redacted>"));
  process.exit(1);
});
