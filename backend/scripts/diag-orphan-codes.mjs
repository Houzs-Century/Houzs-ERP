#!/usr/bin/env node
/* READ-ONLY: internal item codes used on company-1 documents that do NOT exist
 * in scm.mfg_products — the "orphan code" class the 5540-1S line exposed.
 * Counted per document type, then the codes themselves. */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const SRC = [
  ["SO", "scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no=i.doc_no", "h.company_id=1 AND i.cancelled=false"],
  ["PO", "scm.purchase_order_items i JOIN scm.purchase_orders h ON h.id=i.purchase_order_id", "h.company_id=1"],
  ["DO", "scm.delivery_order_items i JOIN scm.delivery_orders h ON h.id=i.delivery_order_id", "h.company_id=1"],
  ["GRN", "scm.grn_items i JOIN scm.grns h ON h.id=i.grn_id", "h.company_id=1"],
  ["SI", "scm.sales_invoice_items i JOIN scm.sales_invoices h ON h.id=i.sales_invoice_id", "h.company_id=1"],
  ["PI", "scm.purchase_invoice_items i JOIN scm.purchase_invoices h ON h.id=i.purchase_invoice_id", "h.company_id=1"],
];
for (const [label, from, where] of SRC) {
  const r = await sql.unsafe(`SELECT COUNT(*)::int AS orphan_lines, COUNT(DISTINCT i.item_code)::int AS codes
    FROM ${from} WHERE ${where}
      AND i.item_code IS NOT NULL AND btrim(i.item_code) <> ''
      AND NOT EXISTS (SELECT 1 FROM scm.mfg_products p WHERE p.company_id=1 AND upper(p.code)=upper(i.item_code))`);
  console.log(`${label}: ${r[0].orphan_lines} line(s) on ${r[0].codes} code(s) not in the catalog`);
  if (r[0].orphan_lines > 0) {
    const top = await sql.unsafe(`SELECT i.item_code, COUNT(*)::int AS n FROM ${from} WHERE ${where}
        AND NOT EXISTS (SELECT 1 FROM scm.mfg_products p WHERE p.company_id=1 AND upper(p.code)=upper(i.item_code))
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
    for (const x of top) console.log(`     ${x.item_code}: ${x.n}`);
  }
}
await sql.end();
