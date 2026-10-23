// HC-0153 (Sim 2026-10-23): AKEMI SOLITUDE MATT (Q) was deactivated in SKU
// Master and still landed on HC-PO-2610-357, because the PO dropdown lists the
// supplier's bindings and no PO write path asked whether the SKU was active.
// Drives the REAL handlers through the fake PostgREST client (same seam as
// mfgPoBlankExpectedAt.test.ts): a new pick of an INACTIVE SKU is refused on
// create / add-line / code-change edit, while the lines that must keep working
// (SO-linked, one-off codes, unchanged-code edits) still save.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_orders: [{ id: 'po-1', company_id: 1, status: 'DRAFT', supplier_id: 'sup-1', currency: 'MYR' }],
  purchase_order_items: [{
    id: 'poi-1', purchase_order_id: 'po-1', company_id: 1, material_kind: 'mfg_product',
    item_code: 'AK-SOLITUDE-Q', material_name: 'AKEMI SOLITUDE MATT (Q)', qty: 1,
    unit_price_sen: 0, discount_sen: 0, line_total_sen: 0, item_group: 'mattress', so_item_id: null,
  }],
  mfg_products: [
    { id: 'p1', company_id: 1, code: 'AK-SOLITUDE-Q', name: 'AKEMI SOLITUDE MATT (Q)', category: 'MATTRESS', status: 'INACTIVE', model: { active: true } },
    { id: 'p2', company_id: 1, code: 'HS-SOLITUDE-Q', name: 'HAPPI SLEEP SOLITUDE MATT (Q)', category: 'MATTRESS', status: 'ACTIVE', model: { active: true } },
    { id: 'p3', company_id: 1, code: 'AK-RETIRED-MODEL-Q', name: 'AKEMI RETIRED (Q)', category: 'MATTRESS', status: 'ACTIVE', model: { active: false } },
  ],
  mfg_sales_order_items: [],
  grns: [],
  grn_items: [],
  app_config: [],
  entity_audit_log: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function send(method: string, path: string, body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const line = (itemCode: string, extra: Record<string, unknown> = {}) => ({
  materialKind: 'mfg_product', itemCode, materialName: itemCode, qty: 1, unitPriceSen: 100, ...extra,
});
const header = { supplierId: 'sup-1', purchaseLocationId: 'loc-1' };

describe('HC-0153 — a deactivated SKU cannot be newly picked on a PO', () => {
  it('create refuses an INACTIVE SKU and names it', async () => {
    const res = await send('POST', '/', { ...header, items: [line('HS-SOLITUDE-Q'), line('AK-SOLITUDE-Q')] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'unknown_item_code', inactive: ['AK-SOLITUDE-Q'] });
  });

  it('create refuses a SKU whose Model was deactivated', async () => {
    const res = await send('POST', '/', { ...header, items: [line('AK-RETIRED-MODEL-Q')] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ inactive: ['AK-RETIRED-MODEL-Q'] });
  });

  it('create still accepts an ACTIVE SKU and a one-off code the catalogue does not hold', async () => {
    const res = await send('POST', '/', { ...header, items: [line('HS-SOLITUDE-Q'), line('ONE-OFF-CODE')] });
    expect(res.status).toBe(201);
  });

  it('create does not judge fabric / raw lines against the SKU catalogue', async () => {
    const res = await send('POST', '/', { ...header, items: [line('AK-SOLITUDE-Q', { materialKind: 'fabric' })] });
    expect(res.status).toBe(201);
  });

  it('add-line refuses an INACTIVE SKU', async () => {
    const res = await send('POST', '/po-1/items', line('AK-SOLITUDE-Q'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ inactive: ['AK-SOLITUDE-Q'] });
  });

  it('edit that moves the code ONTO an inactive SKU is refused', async () => {
    sb.tables.purchase_order_items.push({
      id: 'poi-2', purchase_order_id: 'po-1', company_id: 1, material_kind: 'mfg_product',
      item_code: 'HS-SOLITUDE-Q', material_name: 'HAPPI SLEEP SOLITUDE MATT (Q)', qty: 1,
      unit_price_sen: 0, discount_sen: 0, line_total_sen: 0, item_group: 'mattress', so_item_id: null,
    });
    const res = await send('PATCH', '/po-1/items/poi-2', { itemCode: 'AK-SOLITUDE-Q' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ inactive: ['AK-SOLITUDE-Q'] });
  });

  it('edit that keeps an already-inactive code stays allowed (legacy line)', async () => {
    const res = await send('PATCH', '/po-1/items/poi-1', { itemCode: 'AK-SOLITUDE-Q', qty: 2 });
    expect(res.status).not.toBe(409);
  });
});
