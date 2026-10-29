#!/usr/bin/env node
// Read-only: what sits on the BEDFRAME KIV codes? (HC-0182)
//
// Sim: "BEDFRAME KIV LV2" is the old code with no size, Sales Orders sit on it,
// and costing needs the sized codes (-(K) / -(Q) / -(S) / -(SK) / -(SP), and the
// odd "BEDFRAME KIV-(SS)"). Before any merge this prints, per code: the catalogue
// row (status, category, size, has-cost, main supplier), how many rows each
// PRODUCT_CODE_CASCADE column holds on it, and every sales line on the unsized
// codes with the size its text and variants carry - the per-line target.
//
// Strictly SELECTs. Public log: no document numbers, no money (yes/no only).
//
// Env: DATABASE_URL (required); COMPANY_ID (default 1); LIKE (default 'BEDFRAME KIV%').
import postgres from 'postgres';
import { PRODUCT_CODE_CASCADE } from '../src/scm/lib/product-code-rename.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const LIKE = process.env.LIKE || 'BEDFRAME KIV%';

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const yes = (n) => (Number(n) > 0 ? 'yes' : 'no');
const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  await sql.begin('read only', async (t) => {
    log(`diag-hc0182-bedframe-kiv - company ${CO}, codes ILIKE '${LIKE}', read-only`);
    const products = await t`
      SELECT p.code, to_jsonb(p) AS j
        FROM scm.mfg_products p
       WHERE p.company_id = ${CO} AND p.code ILIKE ${LIKE}
       ORDER BY p.code`;
    log(`${products.length} catalogue row(s)`);
    const codes = products.map((p) => p.code);
    const binds = codes.length ? await t`
      SELECT b.item_code, s.code AS supplier, to_jsonb(b) AS j
        FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
       WHERE b.company_id = ${CO} AND b.material_kind::text = 'mfg_product' AND b.item_code IN ${t(codes)}` : [];
    const priced = (j) => Object.entries(j).some(([k, v]) => /_sen$/.test(k) && Number(v) > 0);
    for (const { code, j: p } of products) {
      const bs = binds.filter((b) => b.item_code === code);
      log(`  [${code}] name="${p.name}" status=${p.status} cat=${p.category} size_code=${p.size_code ?? '-'} size_label=${p.size_label ?? '-'} model=${p.base_model ?? '-'} created=${String(p.created_at ?? '').slice(0, 10)}`);
      log(`      price2=${yes(p.base_price_sen)} cost=${yes(p.cost_price_sen)} price1=${yes(p.price1_sen)} seat_grid=${Array.isArray(p.seat_height_prices) ? p.seat_height_prices.length : 0} bindings=${bs.length} (${bs.map((b) => `${b.supplier ?? '?'}${b.j.is_main_supplier ? '*' : ''} priced=${priced(b.j) ? 'yes' : 'no'}`).join('; ') || 'none'})`);
    }

    const present = new Set((await t`
      SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'scm'`).map((r) => r.k));
    log('');
    log('rows per cascade column (non-zero only):');
    for (const c of PRODUCT_CODE_CASCADE) {
      if (!present.has(`${c.table}.${c.col}`)) continue;
      const kind = c.kind ? `AND material_kind = 'mfg_product'` : '';
      const rows = codes.length ? await t.unsafe(
        `SELECT ${c.col} AS code, count(*)::int AS n FROM scm.${c.table}
          WHERE company_id = $1 AND ${c.col} = ANY($2::text[]) ${kind} GROUP BY 1 ORDER BY 1`, [CO, codes]) : [];
      for (const r of rows) log(`  ${c.table}.${c.col}  ${r.code}  ${r.n}`);
    }

    const unsized = products.filter((p) => !/-\([A-Z]+\)$/.test(p.code)).map((p) => p.code);
    log('');
    log(`sales lines on unsized code(s) ${unsized.join(', ') || '(none)'}:`);
    if (unsized.length) {
      const lines = await t`
        SELECT i.id, i.item_code, to_jsonb(i) AS j, h.status::text AS so_status, h.created_at::date AS so_created,
               (SELECT count(*)::int FROM scm.delivery_order_items d WHERE d.so_item_id = i.id) AS do_lines,
               (SELECT count(*)::int FROM scm.purchase_order_items po WHERE po.so_item_id = i.id) AS po_lines
          FROM scm.mfg_sales_order_items i
          JOIN scm.mfg_sales_orders h ON h.company_id = i.company_id AND h.doc_no = i.doc_no
         WHERE i.company_id = ${CO} AND i.item_code IN ${t(unsized)}
         ORDER BY i.id`;
      for (const l of lines) {
        const v = l.j.variants && typeof l.j.variants === 'object' ? l.j.variants : {};
        const sizeKeys = Object.fromEntries(Object.entries(v).filter(([k]) => /size|bed|width|length|dimension|custom/i.test(k)));
        log(`  line#${l.id} ${l.item_code} qty=${l.j.qty ?? l.j.quantity} cancelled=${l.j.cancelled ?? false} so=${l.so_status} ${String(l.so_created)} costed=${yes(l.j.line_cost_sen)} do_lines=${l.do_lines} po_lines=${l.po_lines}`);
        log(`      desc="${l.j.description ?? ''}" desc2="${l.j.description2 ?? l.j.desc2 ?? ''}" size-ish variants=${JSON.stringify(sizeKeys)} keys=${Object.keys(v).join(',')}`);
      }
    }
  });
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end({ timeout: 1 }); process.exit(1); });
