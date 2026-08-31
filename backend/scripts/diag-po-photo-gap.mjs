#!/usr/bin/env node
/* READ-ONLY: a PO line converted from an SO line should carry the same photo.
 * Count company-1 PO lines that are LINKED to an SO line which has photos while
 * the PO line has none — the owner's "照片不可能突然不见" check. */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const agg = await sql`SELECT
    COUNT(*)::int AS linked_po_lines,
    COUNT(*) FILTER (WHERE COALESCE(array_length(s.photo_urls,1),0) > 0)::int AS so_has_photo,
    COUNT(*) FILTER (WHERE COALESCE(array_length(s.photo_urls,1),0) > 0
                       AND COALESCE(array_length(i.photo_urls,1),0) = 0)::int AS po_missing,
    COUNT(*) FILTER (WHERE COALESCE(array_length(i.photo_urls,1),0) > 0
                       AND COALESCE(array_length(s.photo_urls,1),0) = 0)::int AS so_missing
  FROM scm.purchase_order_items i
  JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
  JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
  WHERE p.company_id = 1`;
const a = agg[0];
console.log(`company-1 PO lines dedicated to an SO line: ${a.linked_po_lines}`);
console.log(`  their SO line HAS a photo:            ${a.so_has_photo}`);
console.log(`  ...and the PO line has NONE:          ${a.po_missing}   <- the gap`);
console.log(`  reverse (PO has a photo, SO none):    ${a.so_missing}`);
const sample = await sql`SELECT p.po_number, i.item_code, s.doc_no AS so_doc,
    array_length(s.photo_urls,1) AS so_pics, s.linked_ac_dtlkey AS so_dtl, i.linked_ac_dtlkey AS po_dtl
  FROM scm.purchase_order_items i
  JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
  JOIN scm.mfg_sales_order_items s ON s.id = i.so_item_id
  WHERE p.company_id = 1 AND COALESCE(array_length(s.photo_urls,1),0) > 0
    AND COALESCE(array_length(i.photo_urls,1),0) = 0
  ORDER BY p.po_number DESC LIMIT 12`;
console.log(`\nsample of the gap (newest 12):`);
for (const r of sample) console.log(`   ${r.po_number} ${r.item_code} <- ${r.so_doc} (SO pics=${r.so_pics}, SO dtl=${r.so_dtl ?? '-'}, PO dtl=${r.po_dtl ?? '-'})`);
await sql.end();
