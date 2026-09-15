// TEMPORARY read-only probe (fix/po-line-realign-to-so-line). Removed before merge.
// RE-RUN: read-only.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const out = (t, rows) => { console.log(`== ${t}: ${rows.length}`); for (const r of rows) console.log("   " + JSON.stringify(r)); };
const run = async (t, q) => { try { out(t, await q()); } catch (e) { console.log(`== ${t}: ERROR ${e.message}`); } };
try {
  await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`;
  await run("products", () => sql`SELECT * FROM scm.mfg_products WHERE upper(code) IN ('AMN-SOFA PILLOW','SQUARE PILLOW','SOFA PILLOW (FOC)')`);
  await run("bindings", () => sql`SELECT b.item_code, b.supplier_id::text, s.code AS supplier_code, s.name AS supplier, b.supplier_sku, b.ac_item_code, b.unit_price_sen, b.is_main_supplier, b.company_id
    FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
   WHERE b.material_kind = 'mfg_product' AND upper(b.item_code) IN ('AMN-SOFA PILLOW','SQUARE PILLOW') ORDER BY b.item_code, b.company_id`);
  await run("po lines AMN-SOFA PILLOW (company 1, newest 25)", () => sql`SELECT p.po_number, p.status::text, s.name AS supplier, i.supplier_sku, i.description, i.material_name, i.unit_price_sen, i.item_group, i.variants, i.linked_ac_dtlkey, p.created_at::date::text AS d
    FROM scm.purchase_order_items i JOIN scm.purchase_orders p ON p.id = i.purchase_order_id LEFT JOIN scm.suppliers s ON s.id = p.supplier_id
   WHERE p.company_id = 1 AND upper(i.item_code) = 'AMN-SOFA PILLOW' ORDER BY p.created_at DESC LIMIT 25`);
  await run("HC-PO-010086 header + supplier", () => sql`SELECT p.po_number, p.supplier_id::text, s.code, s.name, p.subtotal_sen, p.total_sen, p.linked_ac_docno FROM scm.purchase_orders p LEFT JOIN scm.suppliers s ON s.id = p.supplier_id WHERE p.po_number = 'HC-PO-010086'`);
  await run("HC-PO-010086 lines", () => sql`SELECT id::text, item_code, supplier_sku, description, unit_price_sen, line_total_sen, delivery_date::text, warehouse_id::text, linked_ac_dtlkey, photo_urls FROM scm.purchase_order_items WHERE purchase_order_id = (SELECT id FROM scm.purchase_orders WHERE po_number = 'HC-PO-010086')`);
  await run("entity audit HC-PO-010086 all time", () => sql`SELECT created_at, action, actor_name_snapshot, source, left(field_changes::text, 300) AS fc, note FROM scm.entity_audit_log WHERE entity_doc_no = 'HC-PO-010086' ORDER BY created_at`);
  await run("po_revisions HC-PO-010086", () => sql`SELECT revision, amendment_id::text, created_at, left(snapshot::text, 1500) AS snap FROM scm.po_revisions WHERE po_id = (SELECT id FROM scm.purchase_orders WHERE po_number = 'HC-PO-010086') ORDER BY revision`);
} finally { await sql.end({ timeout: 5 }); }
