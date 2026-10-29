// HC-0090: a recorded Supplier Date 2/3/4 is history. The header PATCH may fill
// an empty slot but not rewrite/clear a filled one, and the bulk writer's slot
// write is conditional on the slot still being empty.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';
import { cascadePoSupplierDate, supplierDatePatchGate } from '../lib/po-supplier-date-cascade';

const sb = fakeSb({
  purchase_orders: [{
    id: 'po-1', po_number: 'PO-2610-001', status: 'SUBMITTED', company_id: 1,
    po_date: '2026-10-01', expected_at: '2026-10-10', currency: 'MYR', notes: null,
    supplier_id: 'sup-1', purchase_location_id: 'loc-1',
    supplier_delivery_date_2: '2026-10-14', supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  }],
  grns: [], purchase_order_items: [], app_config: [], entity_audit_log: [],
});
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));
const po = () => (sb.tables.purchase_orders[0] ?? {}) as Row;

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;
const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function patch(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => { c.set('user', CALLER); c.set('companyId', 1); await next(); });
  app.route('/', mfgPurchaseOrders);
  return app.request('/po-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PATCH header: recorded supplier dates', () => {
  it('refuses to overwrite Date 2 and writes nothing', async () => {
    const res = await patch({ supplierDeliveryDate2: '2026-10-20' });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe('supplier_date_recorded');
    expect(po().supplier_delivery_date_2).toBe('2026-10-14');
  });
  it('refuses to clear a recorded date', async () => {
    expect((await patch({ supplierDeliveryDate2: '' })).status).toBe(409);
    expect(po().supplier_delivery_date_2).toBe('2026-10-14');
  });
  it('accepts the same value re-sent plus a fill of the empty Date 3', async () => {
    const res = await patch({ supplierDeliveryDate2: '2026-10-14', supplierDeliveryDate3: '2026-10-21' });
    expect(res.status).toBe(200);
    expect(po().supplier_delivery_date_3).toBe('2026-10-21');
  });
});

describe('supplierDatePatchGate', () => {
  it('flags only filled slots whose value differs; lists newly filled slots', () => {
    const before = { supplier_delivery_date_2: '2026-10-14', supplier_delivery_date_3: null };
    const ok = supplierDatePatchGate(before, { supplier_delivery_date_2: '2026-10-14', supplier_delivery_date_3: '2026-10-21' });
    expect(ok.refusal).toBeNull();
    expect(ok.fill).toEqual(['supplier_delivery_date_3']);
    expect(supplierDatePatchGate(before, { supplier_delivery_date_2: null }).refusal?.slots).toEqual([2]);
  });
});

describe('PATCH header: concurrent fill of the same empty slot', () => {
  it('the second writer gets 409 and does not overwrite', async () => {
    sb.tables.purchase_orders[0]!.supplier_delivery_date_4 = null;
    // Simulates A winning between B's read and B's write: B's update is conditional on Date 4 still NULL.
    const a = await patch({ supplierDeliveryDate4: '2026-11-01' });
    expect(a.status).toBe(200);
    const b = await patch({ supplierDeliveryDate4: '2026-11-09' });
    expect(b.status).toBe(409);
    expect(po().supplier_delivery_date_4).toBe('2026-11-01');
  });
});

describe('cascadePoSupplierDate requireEmpty', () => {
  const args = (before: Record<string, unknown>) => ({
    companyId: 1, poId: 'po-2', before, slot: 2 as const, date: '2026-10-30',
    applyToLines: false, actor: null, note: null, requireEmpty: true,
  });
  it('second write to the same slot does not overwrite the first', async () => {
    const s = fakeSb({ purchase_orders: [{ id: 'po-2', company_id: 1, supplier_delivery_date_2: null }], purchase_order_items: [], entity_audit_log: [] });
    const first = await cascadePoSupplierDate(s, args({}));
    expect(first).toEqual({ ok: true });
    const again = await cascadePoSupplierDate(s, { ...args({}), date: '2026-11-05' });
    expect(again.ok).toBe(false);
    expect(s.tables.purchase_orders[0]?.supplier_delivery_date_2).toBe('2026-10-30');
  });
});
