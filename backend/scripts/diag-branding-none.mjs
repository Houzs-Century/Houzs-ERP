#!/usr/bin/env node
/* READ-ONLY: why does HC-SO-013402 (a TRION bedframe) render branding "NONE"?
 * Dumps the line's stored group, its catalog category + branding text, and a
 * census of every company-1 line whose branding text is literally "NONE". */
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required"); process.exit(2); }
const sql = postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 30, prepare: false });

const docs = ["HC-SO-013402", "HC-SO-013403"];
for (const d of docs) {
  const rows = await sql`SELECT i.line_no, i.item_code, i.item_group, i.branding AS line_branding,
      p.category AS catalog_category, p.branding AS product_branding, h.branding AS header_branding
    FROM scm.mfg_sales_order_items i
    JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
    LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = h.company_id
    WHERE i.doc_no = ${d} AND i.cancelled = false
    ORDER BY i.line_no NULLS LAST, i.created_at`;
  console.log(`\n${d} (header branding=${rows[0]?.header_branding ?? "NULL"}):`);
  for (const r of rows) console.log(`   ${r.item_code} group=${r.item_group ?? "-"} line_branding=${JSON.stringify(r.line_branding)} catalog=${r.catalog_category ?? "NOT IN CATALOG"} product_branding=${JSON.stringify(r.product_branding)}`);
}

const census = await sql`SELECT COALESCE(p.category,'(not in catalog)') AS cat, COUNT(*)::int AS n
  FROM scm.mfg_sales_order_items i
  JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
  LEFT JOIN scm.mfg_products p ON p.code = i.item_code AND p.company_id = h.company_id
  WHERE h.company_id = 1 AND i.cancelled = false AND upper(btrim(COALESCE(i.branding,''))) = 'NONE'
  GROUP BY 1 ORDER BY 2 DESC`;
console.log(`\ncompany-1 lines whose stored branding text is literally "NONE", by catalog category:`);
for (const r of census) console.log(`   ${r.cat}: ${r.n}`);

const prod = await sql`SELECT COALESCE(category,'(null)') AS cat, COUNT(*)::int AS n
  FROM scm.mfg_products WHERE company_id = 1 AND upper(btrim(COALESCE(branding,''))) = 'NONE' GROUP BY 1 ORDER BY 2 DESC`;
console.log(`\ncompany-1 PRODUCTS whose branding is literally "NONE":`);
for (const r of prod) console.log(`   ${r.cat}: ${r.n}`);
await sql.end();
