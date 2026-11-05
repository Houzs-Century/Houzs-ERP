// HC-0153 (finding 1): the Purchase Consignment Order write paths had no
// active-SKU check, so "Copy as new" carried a deactivated SKU onto a fresh PCO.
// Same seam as mfgPoInactiveSku.test.ts: real handlers over the fake PostgREST client.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_consignment_orders: [{ id: 'pco-1', company_id: 1, status: 'SUBMITTED', supplier_id: 'sup-1' }],
  purchase_consignment_order_items: [
    { id: 'pcoi-old', purchase_consignment_order_id: 'pco-1', company_id: 1, material_kind: 'mfg_product', item_code: 'AK-OLD-Q', material_name: 'OLD', qty: 1, unit_price_sen: 0, discount_sen: 0, line_total_sen: 0 },
    { id: 'pcoi-ok', purchase_consignment_order_id: 'pco-1', company_id: 1, material_kind: 'mfg_product', item_code: 'HS-OK-Q', material_name: 'OK', qty: 1, unit_price_sen: 0, discount_sen: 0, line_total_sen: 0 },
  ],
  purchase_consignment_receives: [],
  mfg_products: [
    { id: 'p1', company_id: 1, code: 'AK-OLD-Q', name: 'OLD', category: 'MATTRESS', status: 'INACTIVE', model: { active: true } },
    { id: 'p2', company_id: 1, code: 'HS-OK-Q', name: 'OK', category: 'MATTRESS', status: 'ACTIVE', model: { active: true } },
  ],
  app_config: [],
  entity_audit_log: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { purchaseConsignmentOrders } = await import('./purchase-consignment-orders');

async function send(method: string, path: string, body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  app.route('/', purchaseConsignmentOrders);
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const line = (itemCode: string, extra: Record<string, unknown> = {}) => ({
  materialKind: 'mfg_product', itemCode, materialName: itemCode, qty: 1, unitPriceSen: 100, ...extra,
});
const header = { supplierId: 'sup-1', purchaseLocationId: 'loc-1' };

describe('HC-0153 — a deactivated SKU cannot be newly picked on a Purchase Consignment Order', () => {
  it('create refuses an INACTIVE SKU and names it', async () => {
    const res = await send('POST', '/', { ...header, items: [line('HS-OK-Q'), line('AK-OLD-Q')] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'unknown_item_code', inactive: ['AK-OLD-Q'] });
  });

  it('create still accepts an ACTIVE SKU', async () => {
    const res = await send('POST', '/', { ...header, items: [line('HS-OK-Q')] });
    expect(res.status).toBe(201);
  });

  it('add-line refuses an INACTIVE SKU', async () => {
    const res = await send('POST', '/pco-1/items', line('AK-OLD-Q'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ inactive: ['AK-OLD-Q'] });
  });

  it('add-line accepts an ACTIVE SKU', async () => {
    const res = await send('POST', '/pco-1/items', line('HS-OK-Q'));
    expect(res.status).toBe(201);
  });

  it('edit that moves the code ONTO an inactive SKU is refused', async () => {
    const res = await send('PATCH', '/pco-1/items/pcoi-ok', { itemCode: 'AK-OLD-Q' });
    expect(res.status).toBe(409);
  });

  it('edit that keeps an already-inactive code stays allowed (legacy line)', async () => {
    const res = await send('PATCH', '/pco-1/items/pcoi-old', { itemCode: 'AK-OLD-Q', qty: 2 });
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(200);
  });
});
