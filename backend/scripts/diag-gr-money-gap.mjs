#!/usr/bin/env node
/* Why four migrated goods receipts carry a different total from the book.
 * READ-ONLY. It writes nothing and it decides nothing.
 * ---------------------------------------------------------------------------
 * Run 34263816266: GOODS RECEIPTS, `the money the book states` — 4 documents
 * differ, 0 of them on a proceeded order. The book's own lines already say why,
 * and they say TWO different things, which is the whole reason this prints
 * before anything is repaired. A sweep that mixed the two causes would
 * overwrite a correct row.
 *
 *   GR-005363 / GR-005367 / GR-005368 — a SUPPLIER DISCOUNT that never arrived.
 *   AutoCount stores both halves on the order line: `UnitPrice` undiscounted
 *   and `SubTotal` discounted. On these three the book's own SubTotal is
 *   exactly 0.75 x UnitPrice x Qty, so the ERP total is the book's x 4/3.
 *
 *   GR-005326 — NOT a discount. Its lines carry SubTotal = Qty x UnitPrice with
 *   no discount anywhere; the receipt simply prices two items ABOVE the order
 *   (NH39(A)(K) 830 vs 800, LSD013 (Q) 225 vs 200). A different cause, and it
 *   must not be folded into the same repair.
 *
 * WHY IT ONLY PRINTS. Changing `unit_price_sen` on a POSTED receipt is not a
 * pointer write: scripts/../src/scm/lib/recost.ts cascades a receipt's price
 * into its lots, then consumptions, movements, delivery orders and sales
 * invoices. That is inventory VALUE, and the owner has deferred stock
 * (「库存先不看」). So this reports the gap, the cause and what the receipts
 * actually moved, and leaves the decision where it belongs.
 *
 * CURRENCY. Read from OUR OWN column, never assumed. docs/bugs/0721: the
 * reconcile exports LOCAL currency while the ERP holds DOCUMENT currency, and
 * reading one as the other wrote RM 13,068.55 of imaginary discount onto a CNY
 * purchase order. All four of these are MYR at rate 1.000000 in the book; the
 * ERP side is printed so the two can be compared rather than assumed equal.
 */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
const CO = Number(process.env.COMPANY_ID || 1);
const DOCS = (process.env.GR_DOCS || "GR-005363,GR-005367,GR-005368,GR-005326")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const say = (m) => console.log(m);

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
try {
  const heads = await sql`
    SELECT g.grn_number, g.linked_ac_gr_docno AS ac_doc, g.status, g.currency, g.exchange_rate,
           p.po_number, p.linked_ac_docno AS ac_po,
           (SELECT COUNT(*) FROM scm.grn_items x WHERE x.grn_id = g.id)::int AS lines,
           (SELECT COALESCE(SUM(x.qty_accepted * x.unit_price_sen), 0) FROM scm.grn_items x WHERE x.grn_id = g.id)::bigint AS line_sen,
           (SELECT COUNT(*) FROM scm.inventory_movements m
             WHERE m.source_doc_type = 'GRN' AND m.source_doc_id = g.id)::int AS movements
      FROM scm.grns g
      LEFT JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
     WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno = ANY(${DOCS})
     ORDER BY g.linked_ac_gr_docno`;

  for (const h of heads) {
    say(`\n### ${h.ac_doc}  (ERP ${h.grn_number}, order ${h.ac_po})  status=${h.status}` +
        `  currency=${h.currency ?? "(null)"} rate=${h.exchange_rate ?? "(null)"}`);
    say(`    ${h.lines} line(s) · line money RM ${(Number(h.line_sen) / 100).toFixed(2)} · ` +
        `${h.movements} inventory movement(s) on this receipt`);
    const items = await sql`
      SELECT gi.item_code, gi.qty_accepted, gi.unit_price_sen, gi.linked_ac_dtlkey::text AS dtlkey,
             poi.unit_price_sen AS po_unit_sen
        FROM scm.grn_items gi
        JOIN scm.grns g ON g.id = gi.grn_id
        LEFT JOIN scm.purchase_order_items poi ON poi.id = gi.purchase_order_item_id
       WHERE g.company_id = ${CO} AND g.linked_ac_gr_docno = ${h.ac_doc}
       ORDER BY gi.item_code, gi.id`;
    for (const i of items) {
      say(`      ${String(i.item_code).slice(0, 30).padEnd(32)} qty ${i.qty_accepted}` +
          ` @ RM ${(Number(i.unit_price_sen) / 100).toFixed(4)}` +
          `  (order line RM ${i.po_unit_sen == null ? "—" : (Number(i.po_unit_sen) / 100).toFixed(4)})` +
          `  book line ${i.dtlkey ?? "(none)"}`);
    }
  }
  say(`\n${heads.length} of ${DOCS.length} receipt(s) found. Nothing was written.`);
} finally {
  await sql.end({ timeout: 5 });
}
