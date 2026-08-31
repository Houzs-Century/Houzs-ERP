#!/usr/bin/env node
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const codes = await sql`SELECT code, name, category::text AS cat, base_model, status
  FROM scm.mfg_products WHERE company_id=1 AND (code ILIKE '5540%' OR code ILIKE '8030%' OR code ILIKE '5537%')
  ORDER BY code LIMIT 25`;
console.log("catalog rows:");
for (const r of codes) console.log(`   ${r.code} | ${r.name ?? ''} | ${r.cat} | model=${r.base_model ?? '-'} | ${r.status ?? ''}`);
const po = await sql`SELECT p.po_number, p.linked_ac_docno, i.item_code, i.supplier_sku, i.so_item_id IS NOT NULL AS linked
  FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id=i.purchase_order_id
  WHERE p.company_id=1 AND p.linked_ac_docno IN ('PO-010087','PO-010083')`;
console.log("\nthe two POs' lines now:");
for (const r of po) console.log(`   ${r.po_number} ${r.item_code} sku=${r.supplier_sku ?? '-'} so-linked=${r.linked}`);
const hok = await sql`SELECT i.item_code, COUNT(*)::int AS n FROM scm.purchase_order_items i
  JOIN scm.purchase_orders p ON p.id=i.purchase_order_id
  WHERE p.company_id=1 AND i.supplier_sku ILIKE 'HOK-%' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`;
console.log("\ninternal codes used on HOK-supplied PO lines:");
for (const r of hok) console.log(`   ${r.item_code}: ${r.n}`);
await sql.end();
