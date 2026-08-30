#!/usr/bin/env node
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
const r = await sql`SELECT to_char(h.so_date,'YYYY-MM') AS ym,
    COUNT(*)::int AS sofa_lines,
    COUNT(*) FILTER (WHERE i.item_code ~ '-1S$')::int AS placeholders
  FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no
  WHERE h.company_id=1 AND h.linked_ac_docno IS NOT NULL AND i.cancelled=false
    AND lower(COALESCE(i.item_group,''))='sofa' AND h.so_date IS NOT NULL
  GROUP BY 1 ORDER BY 1 DESC LIMIT 10`;
console.log("sofa lines by order month — placeholders / total:");
for (const x of r) console.log(`   ${x.ym}: ${x.placeholders}/${x.sofa_lines}  (${Math.round(100*x.placeholders/x.sofa_lines)}%)`);
const codes = await sql`SELECT i.item_code, COUNT(*)::int AS n,
    BOOL_OR(EXISTS(SELECT 1 FROM scm.mfg_products p WHERE p.company_id=1 AND upper(p.code)=upper(i.item_code))) AS in_catalog
  FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no
  WHERE h.company_id=1 AND i.cancelled=false AND i.item_code ~ '-1S$'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 8`;
console.log("\nplaceholder codes in use (and whether the catalog has them):");
for (const x of codes) console.log(`   ${x.item_code}: ${x.n} line(s), in catalog=${x.in_catalog}`);
await sql.end();
