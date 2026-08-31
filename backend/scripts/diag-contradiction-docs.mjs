#!/usr/bin/env node
/* READ-ONLY: the photo-vs-text contradiction docs and the handedness-unknown
 * ones — have they been PROCEEDED (a PO raised / goods received)? The owner's
 * rule 2026-08-31: not proceeded -> fill something in, a human corrects later. */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const DOCS = ['HC-SO-010123','HC-SO-010121','HC-SO-002961','HC-SO-008683','HC-SO-010415','HC-SO-010416','HC-SO-010324','HC-SO-011453','HC-SO-013322','HC-SO-013254','HC-SO-011454','HC-SO-012026','HC-SO-012635','HC-SO-013262','HC-SO-013286','HC-SO-013329','HC-SO-012947','HC-SO-009602'];
const rows = await sql`SELECT h.doc_no, h.status::text AS st, h.processing_date,
    (SELECT COUNT(*)::int FROM scm.purchase_order_items p
       JOIN scm.mfg_sales_order_items i ON i.id = p.so_item_id
      WHERE i.doc_no = h.doc_no) AS po_lines,
    (SELECT COALESCE(SUM(p.received_qty),0)::int FROM scm.purchase_order_items p
       JOIN scm.mfg_sales_order_items i ON i.id = p.so_item_id
      WHERE i.doc_no = h.doc_no) AS recv,
    (SELECT COUNT(*)::int FROM scm.delivery_order_items d
       JOIN scm.mfg_sales_order_items i ON i.id = d.so_item_id
      WHERE i.doc_no = h.doc_no) AS do_lines
  FROM scm.mfg_sales_orders h WHERE h.doc_no = ANY(${DOCS}) ORDER BY h.doc_no`;
console.log('doc              status         pdate       PO-lines recv DO-lines   -> verdict');
for (const r of rows) {
  const v = r.do_lines > 0 ? 'DELIVERED — do NOT touch' : r.recv > 0 ? 'goods RECEIVED — careful' : r.po_lines > 0 ? 'PO raised, nothing received' : 'NOT proceeded — safe to fill';
  console.log(`${r.doc_no}  ${String(r.st).padEnd(13)} ${String(r.processing_date ?? '-').slice(0,10).padEnd(11)} ${String(r.po_lines).padStart(6)} ${String(r.recv).padStart(5)} ${String(r.do_lines).padStart(7)}   -> ${v}`);
}
console.log(`\ntotal ${rows.length} of ${DOCS.length} found`);
await sql.end();
