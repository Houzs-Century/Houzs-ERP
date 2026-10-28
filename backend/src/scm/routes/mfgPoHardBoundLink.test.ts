// A company-1 sofa / Sofa Accessory purchase line must stay countable by MRP as
// the purchase for its own sales line (owner 2026-09-15, 「我们明明已经开了 PO，
// 可是它又显示着 shortage」). Drives the REAL PO line handlers through the fake
// PostgREST client and pins the write-side rules of lib/hard-bound-po-line.ts:
//   1. add-line refuses a link whose category disagrees with a bound sales line;
//   2. line edit stores the SKU's category, not the one the client sent;
//   3. line edit refuses clearing the link on a bound line, and a wrong-category
//      relink;
//   4. an allocation split of a bound line is refused;
//   5. bare create refuses the same cross-category link.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_orders: [
    { id: 'po-1', po_number: 'HC-PO-1', status: 'SUBMITTED', company_id: 1, supplier_id: 'sup-1', purchase_location_id: 'loc-1' },
  ],
  purchase_order_items: [
    { id: 'poi-sofa', purchase_order_id: 'po-1', company_id: 1, material_kind: 'mfg_product', item_code: '8030-1A(LHF)', material_name: 'Sofa 1A', item_group: 'sofa', variants: {}, qty: 1, unit_price_sen: 100, discount_sen: 0, line_total_sen: 100, received_qty: 0, so_item_id: 'so-sofa' },
  ],
  mfg_products: [
    { code: '8030-1A(LHF)', category: 'SOFA', company_id: 1 },
    { code: 'SQUARE PILLOW', category: 'FABRIC_ACCESSORY', company_id: 1 },
  ],
  mfg_sales_order_items: [
    { id: 'so-sofa', doc_no: 'HC-SO-1', company_id: 1, item_code: '8030-1A(LHF)', item_group: 'sofa', variants: {}, qty: 1, po_qty_picked: 0, cancelled: false },
    { id: 'so-sofa-2', doc_no: 'HC-SO-2', company_id: 1, item_code: '8030-1A(LHF)', item_group: 'others', variants: {}, qty: 1, po_qty_picked: 0, cancelled: false },
    { id: 'so-pillow', doc_no: 'HC-SO-3', company_id: 1, item_code: 'SQUARE PILLOW', item_group: 'accessory', variants: {}, qty: 1, po_qty_picked: 0, cancelled: false },
  ],
  mfg_sales_orders: [
    { doc_no: 'HC-SO-1', status: 'CONFIRMED', company_id: 1 },
    { doc_no: 'HC-SO-2', status: 'CONFIRMED', company_id: 1 },
    { doc_no: 'HC-SO-3', status: 'CONFIRMED', company_id: 1 },
  ],
  purchase_order_item_allocations: [],
  grns: [],
  app_config: [],
  entity_audit_log: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function call(method: string, path: string, body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  const res = await app.request(path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, {} as Env);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Row };
}

const sofaLine = () => sb.tables.purchase_order_items.find((r) => r.id === 'poi-sofa') as Row;

describe('hard-bound purchase lines keep their sales line', () => {
  it('add-line refuses a Sofa Accessory line linked to a sales line still filed as accessory', async () => {
    const before = sb.tables.purchase_order_items.length;
    const res = await call('POST', '/po-1/items', {
      itemCode: 'SQUARE PILLOW', materialName: 'Square Pillow', materialKind: 'mfg_product',
      qty: 1, unitPriceSen: 100, soItemId: 'so-pillow',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('so_link_category_mismatch');
    expect(String(res.body.message ?? '').length).toBeGreaterThan(0);
    expect(String(res.body.message).length).toBeLessThan(200);
    expect(sb.tables.purchase_order_items.length).toBe(before);
  });

  it('line edit stores the SKU category, not the one sent', async () => {
    const res = await call('PATCH', '/po-1/items/poi-sofa', { itemGroup: 'others', soItemId: 'so-sofa' });
    expect(res.status).toBe(200);
    expect(sofaLine().item_group).toBe('sofa');
  });

  it('line edit refuses clearing the link on a bound line', async () => {
    const res = await call('PATCH', '/po-1/items/poi-sofa', { soItemId: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('hard_bound_unlink_refused');
    expect(String(res.body.message ?? '').length).toBeGreaterThan(0);
    expect(String(res.body.message).length).toBeLessThan(200);
    expect(sofaLine().so_item_id).toBe('so-sofa');
  });

  it('line edit refuses re-linking to a sales line of another category', async () => {
    const res = await call('PATCH', '/po-1/items/poi-sofa', { soItemId: 'so-sofa-2' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('so_link_category_mismatch');
    expect(String(res.body.message ?? '').length).toBeGreaterThan(0);
    expect(String(res.body.message).length).toBeLessThan(200);
    expect(sofaLine().so_item_id).toBe('so-sofa');
  });

  it('an allocation split of a bound line is refused', async () => {
    const res = await call('POST', '/po-1/items/poi-sofa/allocations', { qty: 1, soItemId: 'so-sofa' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('hard_bound_line_not_splittable');
    expect(String(res.body.message ?? '').length).toBeGreaterThan(0);
    expect(String(res.body.message).length).toBeLessThan(200);
    expect(sb.tables.purchase_order_item_allocations.length).toBe(0);
  });

  it('bare create refuses the same cross-category link', async () => {
    const before = sb.tables.purchase_orders.length;
    const res = await call('POST', '/', {
      supplierId: 'sup-1', purchaseLocationId: 'loc-1', confirmOverConvert: true,
      items: [{ itemCode: 'SQUARE PILLOW', materialName: 'Square Pillow', materialKind: 'mfg_product', qty: 1, unitPriceSen: 100, soItemId: 'so-pillow' }],
    });
    expect(res.body.error).toBe('so_link_category_mismatch');
    expect(String(res.body.message ?? '').length).toBeGreaterThan(0);
    expect(String(res.body.message).length).toBeLessThan(200);
    expect(res.status).toBe(409);
    expect(sb.tables.purchase_orders.length).toBe(before);
  });
});
