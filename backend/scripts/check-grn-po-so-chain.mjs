#!/usr/bin/env node
/* check-grn-po-so-chain — READ-ONLY: print the raw rows behind "the goods were
 * received but the Sales Order line still reads PENDING" for named documents.
 *
 * For each purchase order in PO_NOS: its lines (qty, received_qty, so_item_id,
 * variants summary), every GRN line pointing at them (GRN status, qty_received,
 * qty_accepted, returned_qty), and the linked SO line's stock_status. For each
 * GRN in GRN_NOS: its header and every line with the PO line it points at, so a
 * receipt line that reaches the wrong PO line (or none) is visible.
 *
 * Ticket 20261005-01 (HC-SO-013411 CELENE (A)-(SP), HC-PO-010114,
 * HC-GRN-2609-098 / HC-GRN-2609-054) is the first use.
 *
 * Strictly SELECTs. RE-RUN: read-only and stateless, a second run reports
 * whatever is true then.
 *
 *   DATABASE_URL  required
 *   PO_NOS        comma separated, e.g. HC-PO-010114
 *   GRN_NOS       comma separated, e.g. HC-GRN-2609-098,HC-GRN-2609-054
 */
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const list = (v) => [...new Set((v || "").split(",").map((s) => s.trim()).filter(Boolean))];
const PO_NOS = list(process.env.PO_NOS);
const GRN_NOS = list(process.env.GRN_NOS);
if (PO_NOS.length === 0 && GRN_NOS.length === 0) { console.error("give PO_NOS and/or GRN_NOS"); process.exit(2); }

const log = (m = "") => console.log(m);
const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

try {
  for (const poNo of PO_NOS) {
    const [po] = await db`
      SELECT p.id, p.po_number, p.status, p.company_id, p.linked_ac_docno, s.code AS supplier
      FROM scm.purchase_orders p LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
      WHERE p.po_number = ${poNo}`;
    if (!po) { log(`PO ${poNo}: not found`); continue; }
    log(`PO ${po.po_number}  status=${po.status}  supplier=${po.supplier}  ac=${po.linked_ac_docno}  co=${po.company_id}`);
    const lines = await db`
      SELECT i.id, i.line_no, i.item_code, i.qty, i.received_qty, i.so_item_id, i.description2,
             i.warehouse_id, so.doc_no AS so_doc, so.stock_status AS so_stock, so.stock_qty_ready AS so_ready,
             so.item_group AS so_group, so.description2 AS so_desc2
      FROM scm.purchase_order_items i
      LEFT JOIN scm.mfg_sales_order_items so ON so.id = i.so_item_id
      WHERE i.purchase_order_id = ${po.id} ORDER BY i.line_no`;
    for (const l of lines) {
      log(`  line ${l.line_no} ${l.id}  ${l.item_code}  qty=${l.qty} received=${l.received_qty}  wh=${l.warehouse_id}`);
      log(`    po desc2: ${l.description2 ?? ""}`);
      log(`    so_item_id=${l.so_item_id ?? "NULL"}  so=${l.so_doc ?? "-"} group=${l.so_group ?? "-"} stock=${l.so_stock ?? "-"} ready=${l.so_ready ?? "-"}`);
      log(`    so desc2: ${l.so_desc2 ?? ""}`);
      const gl = await db`
        SELECT g.grn_number, g.status, gi.id, gi.qty_received, gi.qty_accepted, gi.returned_qty, gi.description2
        FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
        WHERE gi.purchase_order_item_id = ${l.id} ORDER BY g.grn_number`;
      if (gl.length === 0) log("    GRN lines: none point at this PO line");
      for (const g of gl) {
        log(`    GRN ${g.grn_number} status=${g.status} line=${g.id} received=${g.qty_received} accepted=${g.qty_accepted} returned=${g.returned_qty}  ${g.description2 ?? ""}`);
      }
    }
    log("");
  }

  for (const grnNo of GRN_NOS) {
    const [g] = await db`
      SELECT g.id, g.grn_number, g.status, g.posted_at, g.warehouse_id, g.linked_ac_gr_docno, g.company_id,
             s.code AS supplier, p.po_number AS header_po
      FROM scm.grns g
      LEFT JOIN scm.suppliers s ON s.id = g.supplier_id
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE g.grn_number = ${grnNo}`;
    if (!g) { log(`GRN ${grnNo}: not found`); continue; }
    log(`GRN ${g.grn_number}  status=${g.status}  posted_at=${g.posted_at}  supplier=${g.supplier}  header_po=${g.header_po}  ac=${g.linked_ac_gr_docno}  wh=${g.warehouse_id}`);
    const items = await db`
      SELECT gi.id, gi.item_code, gi.qty_received, gi.qty_accepted, gi.returned_qty, gi.purchase_order_item_id,
             gi.description2, p.po_number, poi.line_no AS po_line, poi.received_qty AS po_line_received
      FROM scm.grn_items gi
      LEFT JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
      LEFT JOIN scm.purchase_orders p ON p.id = poi.purchase_order_id
      WHERE gi.grn_id = ${g.id} ORDER BY gi.item_code`;
    for (const it of items) {
      log(`  ${it.item_code}  received=${it.qty_received} accepted=${it.qty_accepted} returned=${it.returned_qty}  -> ${it.po_number ?? "NO PO LINE"} line ${it.po_line ?? "-"} (po line received=${it.po_line_received ?? "-"})`);
      log(`    ${it.description2 ?? ""}`);
    }
    log("");
  }
} finally {
  await db.end();
}
