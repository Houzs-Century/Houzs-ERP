#!/usr/bin/env node
/* READ-ONLY: which company-1 sofa PLACEHOLDER lines (`<model>-1S`) now carry a
 * photo, and which of their orders/POs are still open — the work list for the
 * photo-driven compartment pass. */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const so = await sql`SELECT i.doc_no, i.item_code, i.linked_ac_dtlkey AS dtl,
    COALESCE(array_length(i.photo_urls,1),0) AS pics, h.status::text AS st
  FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no
  WHERE h.company_id=1 AND i.cancelled=false AND lower(COALESCE(i.item_group,''))='sofa'
    AND i.item_code ~ '-1S$'
  ORDER BY (COALESCE(array_length(i.photo_urls,1),0) > 0) DESC, i.doc_no DESC`;
const withPic = so.filter((r) => Number(r.pics) > 0);
console.log(`SO placeholder sofa lines: ${so.length}; WITH a photo now: ${withPic.length}`);
for (const r of withPic) console.log(`  ${r.doc_no} ${r.item_code} dtl=${r.dtl ?? '-'} pics=${r.pics} [${r.st}]`);
const po = await sql`SELECT COUNT(*)::int AS n,
    COUNT(*) FILTER (WHERE COALESCE(array_length(i.photo_urls,1),0) > 0)::int AS withpic
  FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id=i.purchase_order_id
  WHERE p.company_id=1 AND lower(COALESCE(i.item_group,''))='sofa' AND i.item_code ~ '-1S$'`;
console.log(`PO placeholder sofa lines: ${po[0].n}; with a photo: ${po[0].withpic}`);
await sql.end();
