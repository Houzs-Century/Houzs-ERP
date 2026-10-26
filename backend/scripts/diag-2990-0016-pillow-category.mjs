#!/usr/bin/env node
// Read-only: which pillow SKUs ask for a fabric on a PO, per company? (2990-0016)
//
// The PO line shows a Fabrics picker when the SKU's category is FABRIC_ACCESSORY
// (Sofa Accessory). Sim: 2990's random-colour pillow asks for a colour, HC's does
// not. This lists every PILLOW SKU in every company with its category, its
// supplier bindings, and the last PO lines that used it (with their variants).
//
// Strictly SELECTs. No DDL, no writes. Exits 0 for every answer.
//
// Env: DATABASE_URL (required); LIKE (default PILLOW); PO_LIMIT (default 40).
import postgres from 'postgres';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const LIKE = `%${String(process.env.LIKE || 'PILLOW').toUpperCase()}%`;
const PO_LIMIT = Number(process.env.PO_LIMIT) > 0 ? Number(process.env.PO_LIMIT) : 40;

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => (sen == null ? '-' : (Number(sen) / 100).toFixed(2));

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`diag-2990-0016-pillow-category — LIKE ${LIKE}, read-only`);
  const [prods, binds, lines] = await sql.begin('read only', async (t) => [
    await t`SELECT c.code AS co, p.company_id, p.code, p.name, p.category::text AS category, p.status::text AS status,
                   p.base_price_sen, p.cost_price_sen
              FROM scm.mfg_products p JOIN public.companies c ON c.id = p.company_id
             WHERE upper(p.code) LIKE ${LIKE} OR upper(p.name) LIKE ${LIKE}
             ORDER BY c.code, p.category, p.code`,
    await t`SELECT b.company_id, b.item_code, b.supplier_sku, b.unit_price_sen, b.is_main_supplier, s.code AS supplier_code, s.name AS supplier_name
              FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
             WHERE b.material_kind = 'mfg_product' AND (upper(b.item_code) LIKE ${LIKE} OR upper(coalesce(b.supplier_sku, '')) LIKE ${LIKE})
             ORDER BY b.company_id, b.item_code`,
    await t`SELECT c.code AS co, p.po_number, p.status::text AS status, p.created_at, to_jsonb(i) AS li
              FROM scm.purchase_order_items i
              JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
              JOIN public.companies c ON c.id = p.company_id
             WHERE upper(coalesce(i.item_code, '')) LIKE ${LIKE}
             ORDER BY p.created_at DESC
             LIMIT ${PO_LIMIT}`,
  ]);

  log('');
  log(`=== SKUs (${prods.length}) ===`);
  for (const p of prods) {
    log(`${p.co} | ${p.category} | ${p.status} | ${p.code} | ${p.name} | base ${rm(p.base_price_sen)} cost ${rm(p.cost_price_sen)}`);
    for (const b of binds.filter((x) => x.company_id === p.company_id && x.item_code === p.code)) {
      log(`      binding ${b.supplier_code ?? '?'} ${b.supplier_name ?? ''} | sku ${b.supplier_sku ?? '-'} | RM ${rm(b.unit_price_sen)}${b.is_main_supplier ? ' | main' : ''}`);
    }
  }
  const orphan = binds.filter((b) => !prods.some((p) => p.company_id === b.company_id && p.code === b.item_code));
  if (orphan.length) {
    log('');
    log(`=== bindings whose item_code matched no SKU above (${orphan.length}) ===`);
    for (const b of orphan) log(`co ${b.company_id} | ${b.item_code} | ${b.supplier_code ?? '?'} | sku ${b.supplier_sku ?? '-'} | RM ${rm(b.unit_price_sen)}`);
  }

  log('');
  log(`=== last ${lines.length} PO lines ===`);
  for (const r of lines) {
    const li = r.li || {};
    log(`${r.co} | ${r.po_number} | ${r.status} | ${new Date(r.created_at).toISOString().slice(0, 10)} | ${li.item_code} | group ${li.item_group ?? '-'} | qty ${li.qty} | variants ${JSON.stringify(li.variants ?? null)}`);
  }
}

main().then(() => sql.end()).catch(async (e) => {
  console.error(e);
  await sql.end({ timeout: 1 });
  process.exit(1);
});
