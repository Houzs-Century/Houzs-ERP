#!/usr/bin/env node
/* READ-ONLY: the owner's MRP question — bedframes it says to ORDER whose book
 * PO is already fully received. For a sample of those SOs: the line, its
 * dedication + receipt, and what stock exists for that code at that warehouse
 * (by variant key), which is where a typed-variant line and blank-variant
 * migrated stock fail to meet. */
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false, ssl: 'require' });
const DOCS = ['HC-SO-007676','HC-SO-013188','HC-SO-009768','HC-SO-009773'];
for (const doc of DOCS) {
  const lines = await sql`SELECT i.id, i.item_code, i.item_group, i.qty, i.stock_status, i.warehouse_id,
      w.name AS wh, (i.variants::text) AS v,
      COALESCE((SELECT COUNT(*) FROM scm.purchase_order_items p WHERE p.so_item_id = i.id),0)::int AS ded,
      COALESCE((SELECT SUM(p.received_qty) FROM scm.purchase_order_items p WHERE p.so_item_id = i.id),0) AS recv
    FROM scm.mfg_sales_order_items i LEFT JOIN scm.warehouses w ON w.id = i.warehouse_id
    WHERE i.doc_no = ${doc} AND i.cancelled = false AND lower(COALESCE(i.item_group,'')) = 'bedframe'`;
  console.log(`\n${doc}: ${lines.length} bedframe line(s)`);
  for (const l of lines) {
    console.log(`  ${l.item_code} qty=${l.qty} status=${l.stock_status} wh=${l.wh ?? '-'} dedications=${l.ded} received=${l.recv}`);
    console.log(`     variants=${(l.v ?? 'null').slice(0,110)}`);
    const st = await sql`SELECT COALESCE(NULLIF(btrim(variant_key),''),'(blank)') AS vk, SUM(qty)::int AS q
      FROM scm.inventory_balances WHERE company_id=1 AND upper(item_code)=upper(${l.item_code})
        AND (${l.warehouse_id}::uuid IS NULL OR warehouse_id = ${l.warehouse_id}::uuid)
      GROUP BY 1 ORDER BY 2 DESC`;
    console.log(`     stock at that warehouse: ${st.length ? st.map((x)=>`${x.vk}=${x.q}`).join(', ') : 'NONE'}`);
  }
}
const agg = await sql`SELECT COALESCE(NULLIF(btrim(b.variant_key),''),'(blank)') AS vk,
    COUNT(*)::int AS cells, SUM(b.qty)::int AS units
  FROM scm.inventory_balances b
  JOIN scm.mfg_products p ON p.code=b.item_code AND p.company_id=1
  WHERE b.company_id=1 AND p.category::text='BEDFRAME' AND b.qty > 0
  GROUP BY 1 ORDER BY 3 DESC LIMIT 6`;
console.log(`\nALL company-1 BEDFRAME stock by variant key:`);
for (const r of agg) console.log(`   ${r.vk}: ${r.cells} cell(s), ${r.units} unit(s)`);
await sql.end();
