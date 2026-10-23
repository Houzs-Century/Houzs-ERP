#!/usr/bin/env node
// Read-only: why do Sales Order lines still carry no cost? (HC-0156)
//
// Finance's "SO - With No Cost" list (projectDataGaps soNoCogs) shows every
// event order line whose line_cost_sen is 0/NULL. The nightly
// restamp-so-cost-from-product fills a 0 line from the CURRENT product cost,
// and the product cost is meant to come from the supplier price list
// (auto-derive). The 2026-10-23 restamp run still left 1,610 company-1 lines
// "product has no cost". This sorts every such line into one reason:
//
//   NO_PRODUCT            the line's item_code is not an mfg_products code
//   LINE_TOTAL_ONLY       unit_cost_sen > 0 but line_cost_sen 0 (restamp skips)
//   FILLABLE              the restamp WILL fill it (product cost readable)
//   RESTAMP_MISSES        the save path reads a cost, the restamp does not
//                         (sofa height carried only as `depth`, etc.)
//   SUPPLIER_NOT_DERIVED  product cost 0, but its suppliers' prices DO give a
//                         cost for this line — auto-derive never wrote it
//   SOFA_NO_HEIGHT        sofa line with no seat size and no flat cost
//   SOFA_HEIGHT_MISSING   sofa grid has cost rows, none at this line's height
//   SUPPLIER_NO_PRICE     bound to a supplier, but no supplier quotes a cost
//   NO_SUPPLIER           no supplier binding at all
//
// Strictly SELECTs. No DDL, no writes. Exits 0 for every answer.
//
// Env: DATABASE_URL (required); COMPANY_ID (default 1); DOC_NOS (comma list,
// print those orders line by line); LIST_LIMIT (codes per reason, default 40);
// EVENTS_ONLY=1 (list only event orders, the Finance list's scope).
import postgres from 'postgres';
import { deriveProductCostFromSuppliers } from '../src/scm/lib/derive-product-cost-from-suppliers.ts';

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error('need DATABASE_URL'); process.exit(2); }
const CO = Number(process.env.COMPANY_ID || 1);
const DOC_NOS = String(process.env.DOC_NOS || '').split(',').map((s) => s.trim()).filter(Boolean);
const LIST_LIMIT = Number(process.env.LIST_LIMIT) > 0 ? Number(process.env.LIST_LIMIT) : 40;

const log = (m = '') => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => (sen == null ? '-' : (Number(sen) / 100).toFixed(2));
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}...` : s);

const heightOf = (v) => {
  const raw = v?.depth ?? v?.seatHeight ?? v?.seat_height ?? null;
  return raw != null && String(raw).trim() !== '' ? String(raw).trim() : null;
};

/** The SO save path (computeMfgLineCost): sofa grid row at the exact height, else flat. */
function saveCost(p, h) {
  if (!p) return 0;
  if (String(p.category || '').toUpperCase() === 'SOFA' && Array.isArray(p.seat_height_prices) && h) {
    const rows = p.seat_height_prices.filter((r) => r && r.height === h && r.priceSen != null);
    const hit = rows.find((r) => (r.tier ?? 'PRICE_2') === 'PRICE_2') ?? rows[0];
    if (hit && Number(hit.priceSen) > 0) return Number(hit.priceSen);
  }
  return Number(p.base_price_sen ?? p.cost_price_sen ?? 0) || 0;
}

/** restamp-so-cost-from-product.mjs unitCostSen, verbatim in effect. */
function restampCost(p, v) {
  if (!p) return 0;
  if (String(p.category || '').toUpperCase() === 'SOFA' && Array.isArray(p.seat_height_prices)) {
    const h = v?.seatHeight ?? v?.seat_height ?? null;
    if (h != null) {
      const hh = String(h).replace(/"/g, '');
      const hit = p.seat_height_prices.find((e) => String(e.height) === hh && (e.tier ?? 'PRICE_2') === 'PRICE_2' && Number(e.priceSen) > 0);
      if (hit) return Number(hit.priceSen);
    }
  }
  return Number(p.base_price_sen) || Number(p.cost_price_sen) || 0;
}

const gridHeights = (rows) => [...new Set((Array.isArray(rows) ? rows : [])
  .filter((r) => r && r.priceSen != null && Number(r.priceSen) > 0).map((r) => String(r.height)))].sort();

const sql = postgres(DSN, { ssl: 'require', prepare: false, max: 1 });

async function main() {
  log(`diag-hc0156-so-no-cost — company ${CO}, read-only`);
  const flag = await sql.begin('read only', (t) => t`SELECT key, value FROM scm.app_config WHERE key = 'scm.auto_derive_product_cost'`);
  log(`auto-derive flag scm.auto_derive_product_cost = ${flag.length ? JSON.stringify(flag[0].value) : '(no row = OFF)'}`);

  const [lines, prods, binds] = await sql.begin('read only', async (t) => [
    await t`SELECT i.id, i.doc_no, i.item_code, i.item_group, i.qty, i.variants, i.unit_cost_sen, i.line_cost_sen,
                   h.project_id, h.status::text AS status, h.created_at
              FROM scm.mfg_sales_order_items i
              JOIN scm.mfg_sales_orders h ON h.company_id = i.company_id AND h.doc_no = i.doc_no
             WHERE i.company_id = ${CO} AND coalesce(i.cancelled, false) = false
               AND h.status::text <> 'CANCELLED'
               AND (coalesce(i.line_cost_sen, 0) = 0 OR coalesce(i.unit_cost_sen, 0) = 0)
               AND i.item_code IS NOT NULL AND lower(coalesce(i.item_group, '')) <> 'service'
             ORDER BY i.doc_no, i.id`,
    await t`SELECT code, name, category, status::text AS status, base_price_sen, cost_price_sen, seat_height_prices
              FROM scm.mfg_products WHERE company_id = ${CO}`,
    await t`SELECT b.item_code, b.supplier_id, b.is_main_supplier, b.unit_price_sen, b.price_matrix, s.code AS supplier_code
              FROM scm.supplier_material_bindings b LEFT JOIN scm.suppliers s ON s.id = b.supplier_id
             WHERE b.company_id = ${CO} AND b.material_kind = 'mfg_product'`,
  ]);
  const prodBy = new Map(prods.map((p) => [p.code, p]));
  const prodByUpper = new Map(prods.map((p) => [String(p.code).trim().toUpperCase(), p]));
  const bindBy = new Map();
  for (const b of binds) {
    if (!bindBy.has(b.item_code)) bindBy.set(b.item_code, []);
    bindBy.get(b.item_code).push(b);
  }

  const classify = (l) => {
    const p = prodBy.get(l.item_code);
    const h = heightOf(l.variants);
    if (!p) return { reason: 'NO_PRODUCT', h, near: prodByUpper.get(String(l.item_code).trim().toUpperCase())?.code ?? null };
    if (Number(l.unit_cost_sen) > 0) return { reason: 'LINE_TOTAL_ONLY', h };
    const sc = saveCost(p, h), rc = restampCost(p, l.variants);
    if (rc > 0) return { reason: 'FILLABLE', h };
    if (sc > 0) return { reason: 'RESTAMP_MISSES', h };
    const bs = bindBy.get(l.item_code) ?? [];
    const sofa = String(p.category || '').toUpperCase() === 'SOFA';
    const d = deriveProductCostFromSuppliers(p.category, bs);
    if (!d.skipped && d.dearnessSen > 0) {
      const dp = { category: p.category, base_price_sen: d.patch.base_price_sen ?? null, cost_price_sen: null, seat_height_prices: d.patch.seat_height_prices ?? null };
      if (saveCost(dp, h) > 0) return { reason: 'SUPPLIER_NOT_DERIVED', h, derived: saveCost(dp, h) };
      if (sofa && !h) return { reason: 'SOFA_NO_HEIGHT', h };
      if (sofa) return { reason: 'SOFA_HEIGHT_MISSING', h, supplierHeights: gridHeights(dp.seat_height_prices) };
    }
    if (sofa && gridHeights(p.seat_height_prices).length > 0) return { reason: h ? 'SOFA_HEIGHT_MISSING' : 'SOFA_NO_HEIGHT', h };
    return { reason: bs.length === 0 ? 'NO_SUPPLIER' : 'SUPPLIER_NO_PRICE', h };
  };

  const rows = lines.map((l) => ({ l, ...classify(l) }));
  const order = ['NO_PRODUCT', 'LINE_TOTAL_ONLY', 'FILLABLE', 'RESTAMP_MISSES', 'SUPPLIER_NOT_DERIVED', 'SOFA_NO_HEIGHT', 'SOFA_HEIGHT_MISSING', 'SUPPLIER_NO_PRICE', 'NO_SUPPLIER'];
  const count = (subset) => order.map((r) => {
    const hit = subset.filter((x) => x.reason === r);
    return `${r} ${hit.length} lines / ${new Set(hit.map((x) => x.l.item_code)).size} codes`;
  }).join('; ');
  log(`zero-cost lines (non-service, live orders): ${rows.length} across ${new Set(rows.map((x) => x.l.doc_no)).size} orders`);
  log(`  all orders:   ${count(rows)}`);
  log(`  event orders: ${count(rows.filter((x) => x.l.project_id != null))}`);

  /* Sofa lines with no usable seat size: would "every priced seat size costs the
     same" settle them? UNIFORM = one PRICE_2 figure across the product's grid. */
  for (const r of ['SOFA_NO_HEIGHT', 'SOFA_HEIGHT_MISSING']) {
    const hit = rows.filter((x) => x.reason === r);
    const uniform = hit.filter((x) => {
      const p2 = (prodBy.get(x.l.item_code)?.seat_height_prices ?? [])
        .filter((e) => e && (e.tier ?? 'PRICE_2') === 'PRICE_2' && Number(e.priceSen) > 0).map((e) => Number(e.priceSen));
      return p2.length > 0 && new Set(p2).size === 1;
    });
    const months = {};
    for (const x of hit) { const m = String(x.l.created_at?.toISOString?.() ?? x.l.created_at ?? '').slice(0, 7); months[m] = (months[m] ?? 0) + 1; }
    log(`  ${r}: ${hit.length} lines; one price at every seat size ${uniform.length} (events ${uniform.filter((x) => x.l.project_id != null).length}); by order month ${JSON.stringify(months)}`);
  }

  const bindText = (code) => (bindBy.get(code) ?? []).map((b) =>
    `${b.supplier_code ?? b.supplier_id}${b.is_main_supplier ? '*' : ''} flat ${rm(b.unit_price_sen)} matrix ${clip(JSON.stringify(b.price_matrix ?? null), 90)}`).join(' | ') || 'none';

  const listed = process.env.EVENTS_ONLY === '1' ? rows.filter((x) => x.l.project_id != null) : rows;
  for (const r of order) {
    const hit = listed.filter((x) => x.reason === r);
    if (hit.length === 0) continue;
    const byCode = new Map();
    for (const x of hit) {
      if (!byCode.has(x.l.item_code)) byCode.set(x.l.item_code, []);
      byCode.get(x.l.item_code).push(x);
    }
    const codes = [...byCode.entries()].sort((a, b) => b[1].length - a[1].length);
    log('');
    log(`== ${r}: ${hit.length} lines, ${codes.length} codes ==`);
    for (const [code, xs] of codes.slice(0, LIST_LIMIT)) {
      const p = prodBy.get(code);
      const heights = [...new Set(xs.map((x) => x.h ?? '-'))].join(',');
      const extra = xs[0].near ? ` near=${xs[0].near}` : xs[0].derived ? ` derived=${rm(xs[0].derived)}` : xs[0].supplierHeights ? ` supplierHeights=${xs[0].supplierHeights.join(',')}` : '';
      log(`  ${code} x${xs.length} [${p ? `${p.category}/${p.status}` : 'no product'}] lineHeights=${heights}${extra}` +
        (p ? ` base=${rm(p.base_price_sen)} cost=${rm(p.cost_price_sen)} grid=${gridHeights(p.seat_height_prices).join(',') || '-'}` : '') +
        ` | suppliers: ${clip(bindText(code), 260)}`);
    }
    if (codes.length > LIST_LIMIT) log(`  ... ${codes.length - LIST_LIMIT} more codes`);
  }

  if (DOC_NOS.length) {
    log('');
    log(`== Orders asked for (${DOC_NOS.length}) ==`);
    for (const doc of DOC_NOS) {
      const xs = rows.filter((x) => x.l.doc_no === doc);
      log(`  ${doc}: ${xs.length ? xs.map((x) => `${x.l.item_code} [${x.reason}${x.h ? ` h=${x.h}` : ''}] variants=${clip(JSON.stringify(x.l.variants ?? null), 120)}`).join(' ; ') : 'no zero-cost line now'}`);
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }).finally(() => sql.end());
