#!/usr/bin/env node
/* check-gr-receipt-location — READ-ONLY. The owner's question of 2026-09-08:
 * he reads the receiving location on every goods receipt, and asked whether the
 * migrated ones carry AutoCount's.
 *
 * They do not COPY it. Both writers DERIVE it from the purchase order:
 *
 *   create-migrated-documents.mjs  `g.items[0].warehouse_id ?? g.po.purchase_location_id`
 *   reshape-migrated-grns.mjs      `d.items.find(i => i.poi?.warehouse_id)?... ?? d.erpPo.purchase_location_id`
 *
 * That is a derivation, and a migration copies rather than computes. This job
 * asks production six things instead of reading them off a migration file:
 *
 *   1. Can changing a migrated receipt's warehouse move stock? `pg_trigger` on
 *      the LIVE database, not the migrations tree — the inventory ledger is fed
 *      by trg_inventory_movement_fifo on scm.inventory_movements, and the API's
 *      warehouse-relocation path (routes/grns.ts:2235-2280) writes an OUT + IN
 *      by hand. A direct UPDATE writes neither, but that has to be SEEN.
 *   2. Do the migrated receipts still carry zero inventory movements? Stock was
 *      re-seeded from AutoCount on 2026-09-07 23:55+08 and matches; anything
 *      that moves stock breaks that re-seed.
 *   3. Does the stored warehouse actually equal the DERIVATION? If it does not,
 *      the writers are not the only thing that has written these rows.
 *   4. Where the committed book cuts carry AutoCount's own GRDTL location, does
 *      the stored warehouse equal it? This is the owner's question, measured.
 *   5. Can one header hold the answer at all — does any in-scope purchase order
 *      have received lines in more than one warehouse? scm.grn_items has no
 *      warehouse column, so a receipt is single-location by construction.
 *   6. Does the shared AutoCount to ERP location map land on real warehouses?
 *
 * STRICTLY READ-ONLY. SELECT only: no DDL, no writes, no transaction, no marker
 * rows. Exits 0 for every legitimate answer — the ANSWER is the output, not the
 * exit code — and non-zero only when the database is unreachable or a query
 * errors. Manual trigger only; own concurrency group.
 *
 * Mirrors backend/scripts/check-currency-and-do-warehouse.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { SALESLOC } from "./lib/ac-stock-compare.mjs";
import { loadBookGrLocations, resolveAcReceiptLocation } from "./lib/ac-gr-location.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data");
const CO = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(CO) || CO <= 0) {
  console.error("COMPANY_ID must be a positive integer");
  process.exit(1);
}

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return fs.readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const out = [];
const line = (m = "") => { out.push(m); console.log(m); };
const notice = (m) => { out.push(m); console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m); };
const U = (s) => String(s ?? "").trim().toUpperCase();
const FENCE = "``" + "`";

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  notice(`=== GR receiving location — company ${CO} — READ-ONLY ===`);
  line("");

  /* 1. WHAT WOULD A LOCATION CHANGE COST? ---------------------------------- */
  line("1. Triggers on the receipt tables (live pg_trigger, not the migrations tree)");
  const trg = await pg`
    SELECT c.relname AS table_name, t.tgname AS trigger_name, p.proname AS function_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND n.nspname = 'scm'
       AND c.relname IN ('grns', 'grn_items', 'inventory_movements')
     ORDER BY c.relname, t.tgname`;
  if (!trg.length) line("   none on scm.grns / scm.grn_items / scm.inventory_movements");
  for (const t of trg) line(`   ${t.table_name}.${t.trigger_name} -> ${t.function_name}()`);
  const onGrns = trg.filter((t) => t.table_name === "grns");
  line(onGrns.length
    ? `   VERDICT: ${onGrns.length} trigger(s) on scm.grns — a warehouse UPDATE is NOT inert, read them before writing`
    : "   VERDICT: no trigger on scm.grns — an UPDATE of warehouse_id writes no inventory movement");
  line("");

  /* 2. ARE THE MIGRATED RECEIPTS STILL STOCK-FREE? ------------------------- */
  line("2. Migrated receipts and their inventory movements");
  const cen = await pg`
    SELECT COUNT(*)::int AS receipts,
           COUNT(*) FILTER (WHERE g.warehouse_id IS NULL)::int AS no_warehouse,
           COUNT(DISTINCT g.warehouse_id)::int AS distinct_warehouses,
           COUNT(*) FILTER (WHERE g.status = 'CANCELLED')::int AS cancelled,
           (SELECT COUNT(*)::int FROM scm.inventory_movements m
             WHERE m.company_id = ${CO} AND m.source_doc_type = 'GRN'
               AND m.source_doc_id IN (SELECT id FROM scm.grns
                                        WHERE company_id = ${CO} AND migrated_no_stock = true)) AS movements
      FROM scm.grns g
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const c = cen[0];
  line(`   migrated receipts: ${c.receipts} (${c.cancelled} cancelled); no warehouse on ${c.no_warehouse}; ${c.distinct_warehouses} distinct warehouses`);
  line(`   inventory movements attributable to them: ${c.movements}`);
  line(c.movements === 0
    ? "   VERDICT: still zero — the 2026-09-07 23:55+08 stock re-seed is not at risk from these documents"
    : "   VERDICT: NOT zero — these receipts DO move stock, so a warehouse change would move it between branches. STOP.");
  line("");

  const byWh = await pg`
    SELECT COALESCE(w.code, '(null)') AS code, COUNT(*)::int AS n
      FROM scm.grns g LEFT JOIN scm.warehouses w ON w.id = g.warehouse_id
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
     GROUP BY 1 ORDER BY 2 DESC`;
  line("   warehouse the migrated receipts currently show:");
  for (const r of byWh) line(`     ${String(r.code).padEnd(22)} ${r.n}`);
  line("");

  /* 3. IS THE STORED VALUE THE DERIVATION? --------------------------------- */
  line("3. Stored warehouse vs the writers' derivation (first received PO line, else the order's location)");
  const rows = await pg`
    SELECT g.id, g.grn_number, g.warehouse_id::text AS stored, w.code AS stored_code,
           g.linked_ac_docno AS ac_po, p.po_number,
           to_jsonb(g) ->> 'linked_ac_gr_docno' AS ac_gr_docno,
           p.purchase_location_id::text AS po_location, p.linked_ac_grn_docnos AS ac_grs,
           (SELECT i.warehouse_id::text FROM scm.purchase_order_items i
             WHERE i.purchase_order_id = p.id AND COALESCE(i.received_qty, 0) > 0
             ORDER BY i.id LIMIT 1) AS first_line_wh,
           (SELECT COUNT(DISTINCT i.warehouse_id)::int FROM scm.purchase_order_items i
             WHERE i.purchase_order_id = p.id AND COALESCE(i.received_qty, 0) > 0) AS line_wh_count,
           ARRAY(SELECT DISTINCT it.item_code FROM scm.grn_items it WHERE it.grn_id = g.id) AS item_codes
      FROM scm.grns g
      JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      LEFT JOIN scm.warehouses w ON w.id = g.warehouse_id
     WHERE g.company_id = ${CO} AND g.migrated_no_stock = true
     ORDER BY g.grn_number`;
  let asDerived = 0;
  const notDerived = [];
  for (const r of rows) {
    const derived = r.first_line_wh ?? r.po_location;
    if (r.stored === derived) asDerived += 1;
    else notDerived.push(`${r.grn_number}: stored=${r.stored_code ?? r.stored} derived=${derived}`);
  }
  line(`   receipts: ${rows.length}; stored value EQUALS the derivation on ${asDerived}; differs on ${notDerived.length}`);
  for (const m of notDerived.slice(0, 20)) line(`     ${m}`);
  line(notDerived.length === 0
    ? "   VERDICT: every migrated receipt shows the DERIVED warehouse — the writers are what wrote these"
    : "   VERDICT: some rows are not the derivation — find out what wrote them before backfilling");
  line("");

  /* 4. THE OWNER'S QUESTION, MEASURED -------------------------------------- */
  line("4. Stored warehouse vs AutoCount's OWN receipt location (GRDTL), where the committed cuts carry it");
  const book = loadBookGrLocations(DATA);
  line(`   book sources on this cut: ${book.sources.join("; ") || "NONE — the GR export did not select Location before 2026-09-08"}`);
  const warehouses = await pg`SELECT id::text AS id, code, name FROM scm.warehouses WHERE company_id = ${CO}`;
  const whByCode = new Map(warehouses.map((w) => [U(w.code), w.id]));
  let known = 0, agree = 0;
  const unanswered = new Map();
  const disagree = [];
  for (const r of rows) {
    /* Ask by the RECEIPT number the row carries. `linked_ac_gr_docno` exists
       since the pair-grain reshape (mig 20260907T2345) and names ONE receipt;
       before it the only handle was the purchase order's receipt list, which is
       why both are read. */
    const acGrs = r.ac_gr_docno ? [r.ac_gr_docno] : (r.ac_grs ?? []);
    const res = resolveAcReceiptLocation(acGrs, r.item_codes ?? [], book, warehouses);
    if (!res.warehouseId) {
      unanswered.set(res.why, (unanswered.get(res.why) ?? 0) + 1);
      continue;
    }
    known += 1;
    if (res.warehouseId === r.stored) agree += 1;
    else disagree.push(`${r.grn_number} (AutoCount ${acGrs.join(",")} / ${r.ac_po}): book=${res.bookLocation} -> ${res.warehouseCode}, ERP=${r.stored_code ?? r.stored}`);
  }
  line(`   receipts the book can answer for: ${known} of ${rows.length}`);
  line(`   the book could NOT answer for ${rows.length - known}:`);
  for (const [why, n] of unanswered) line(`     ${n}x ${why}`);
  line(`   AGREE: ${agree}   DISAGREE: ${disagree.length}`);
  for (const m of disagree) line(`     DIFF ${m}`);
  line(disagree.length === 0
    ? `   VERDICT: on the ${known} receipts the book can answer for, the ERP already shows AutoCount's own location. The other ${rows.length - known} are UNKNOWN, not agreed.`
    : `   VERDICT: ${disagree.length} migrated receipt(s) show a location AutoCount did not record. Those are the backfill set.`);
  line("");

  /* 5. CAN ONE HEADER HOLD THE ANSWER? ------------------------------------- */
  line("5. Purchase orders whose received lines sit in MORE THAN ONE warehouse");
  const multi = rows.filter((r) => (r.line_wh_count ?? 0) > 1);
  line(`   ${multi.length} of ${rows.length} migrated receipts sit on such an order`);
  for (const r of multi.slice(0, 20)) line(`     ${r.grn_number} / ${r.po_number}: ${r.line_wh_count} distinct line warehouses`);
  line(multi.length === 0
    ? "   VERDICT: none — scm.grn_items has no warehouse column, and no in-scope order needs one"
    : "   VERDICT: the header cannot represent these; the receipt shows ONE location and hides the rest");
  line("");

  /* 6. DOES THE SHARED MAP LAND? ------------------------------------------- */
  line("6. The shared AutoCount to ERP location map, resolved against scm.warehouses");
  const missing = [];
  for (const [ac, erp] of Object.entries(SALESLOC)) {
    if (!whByCode.has(U(erp))) missing.push(`${ac} -> ${erp}`);
  }
  line(`   ${Object.keys(SALESLOC).length} mapped codes; ${missing.length} with no warehouse in company ${CO}`);
  for (const m of missing) line(`     MISSING ${m}`);
  line("");

  notice("=== END — nothing was written ===");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, FENCE + "\n" + out.join("\n") + "\n" + FENCE + "\n");
  }
}

main()
  .then(() => pg.end())
  .catch(async (e) => {
    console.error(e);
    await pg.end().catch(() => {});
    process.exit(1);
  });
