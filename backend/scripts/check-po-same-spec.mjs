// Read-only: purchase-order lines that carry the same sofa model / fabric as
// 2990-PO-2610-019 / -020 (8075 BANGGAU, 9079 KABBIN, fabric BROWNIE-01/-02,
// 2A(LHF) + L(RHF)), across both companies and every supplier, Hookka included.
// Prints PO numbers, supplier, item code, variants and qty only. One SELECT.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.log("::error::DATABASE_URL is not set"); process.exit(2); }
const sql = postgres(url, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT p.company_id, p.po_number, LEFT(p.po_date::text,10) AS po_date, p.status::text AS status,
           s.name AS supplier, i.item_code, i.description, i.variants::text AS variants, i.qty
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
      LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
     WHERE (i.item_code ILIKE '%8075%' OR i.item_code ILIKE '%9079%'
            OR i.description ILIKE '%8075%' OR i.description ILIKE '%9079%'
            OR i.variants::text ILIKE '%BROWNIE%' OR i.description ILIKE '%BROWNIE%')
     ORDER BY p.po_date DESC, p.po_number, i.line_no NULLS LAST
     LIMIT 300`;
  console.log(`matching PO lines: ${rows.length}`);
  for (const r of rows) console.log(`  co=${r.company_id} | ${r.po_number} | ${r.po_date} | ${r.status} | ${r.supplier ?? '-'} | ${r.item_code} | ${(r.description ?? '').replace(/\s+/g,' ').slice(0,70)} | ${(r.variants ?? '').slice(0,140)} | qty ${r.qty}`);
} catch (e) { console.log(`::error::query failed: ${e.message}`); process.exitCode = 1; }
finally { await sql.end(); }
