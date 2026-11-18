// Read-only: sales-order lines with the KABBIN (9079) / BANGGAU (8075) models in
// BROWNIE fabric, and whether a live purchase order has been raised for each
// (purchase_order_items.so_item_id). Prints doc numbers, item codes, the build
// summary and the PO numbers only. One SELECT.
import postgres from "postgres";
const url = process.env.DATABASE_URL;
if (!url) { console.log("::error::DATABASE_URL is not set"); process.exit(2); }
const sql = postgres(url, { max: 1, prepare: false });
try {
  const rows = await sql`
    SELECT o.company_id, o.doc_no, LEFT(o.created_at::text,10) AS so_date, o.status::text AS so_status,
           i.item_code, i.qty, i.cancelled,
           COALESCE(i.variants->>'summary', i.variants::text) AS spec,
           i.variants->>'seatHeight' AS seat, COALESCE(i.variants->>'colourId', i.variants->>'fabricCode') AS fabric,
           (SELECT string_agg(DISTINCT p.po_number || ' (' || COALESCE(s.name,'?') || ', ' || p.status::text || ')', '; ')
              FROM scm.purchase_order_items pi JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
              LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
             WHERE pi.so_item_id = i.id AND p.status::text <> 'CANCELLED') AS pos
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no AND o.company_id = i.company_id
     WHERE (i.item_code ILIKE 'KABBIN%' OR i.item_code ILIKE 'BANGGAU%' OR i.item_code ILIKE '%9079%' OR i.item_code ILIKE '%8075%')
       AND (i.variants::text ILIKE '%BROWNIE%')
       AND COALESCE(i.cancelled, false) = false
       AND o.status::text NOT IN ('CANCELLED','DRAFT')
     ORDER BY (SELECT count(*) FROM scm.purchase_order_items pi JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id WHERE pi.so_item_id = i.id AND p.status::text <> 'CANCELLED'), o.created_at DESC
     LIMIT 200`;
  const none = rows.filter((r) => !r.pos);
  console.log(`SO lines KABBIN/BANGGAU in BROWNIE: ${rows.length}; with NO live PO yet: ${none.length}`);
  for (const r of rows) console.log(`  ${r.pos ? 'PO   ' : 'NO PO'} | co=${r.company_id} | ${r.doc_no} | ${r.so_date} | ${r.so_status} | ${r.item_code} | seat ${r.seat ?? '-'} | ${r.fabric ?? '-'} | ${(r.spec ?? '').slice(0,90)} | qty ${r.qty} | ${r.pos ?? '-'}`);
} catch (e) { console.log(`::error::query failed: ${e.message}`); process.exitCode = 1; }
finally { await sql.end(); }
