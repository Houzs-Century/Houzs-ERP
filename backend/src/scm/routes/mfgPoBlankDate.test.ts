import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_orders: [{
    id: 'po-1', po_number: 'PO-2608-001', status: 'SUBMITTED', company_id: 1, updated_at: '2026-08-01T02:00:00.123456+00:00', version: 1,
    po_date: '2026-08-01', expected_at: '2026-09-01', currency: 'MYR',
    notes: null, supplier_id: 'sup-1', purchase_location_id: 'loc-1',
    supplier_delivery_date_2: null,
    supplier_delivery_date_3: null,
    supplier_delivery_date_4: null,
  }],
  grns: [],
  purchase_order_items: [],
  app_config: [],
  entity_audit_log: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const po = () => (sb.tables.purchase_orders[0] ?? {}) as Row;

const CALLER = {
  id: '7',
  email: 'buyer@houzs.test',
  app_metadata: {},
  user_metadata: { name: 'Buyer' },
  aud: 'authenticated',
  created_at: '',
} as unknown as User;

const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');
const withVersion = (body: Record<string, unknown>) => ({
  expectedUpdatedAt: (sb.tables.purchase_orders.find((r) => r.id === 'po-1') as Row | undefined)?.updated_at, ...body,
});

async function patch(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  return app.request('/po-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(withVersion(body)),
  });
}

describe('PATCH mfg purchase order — blank supplier dates', () => {
  it('stores a cleared optional date as NULL and still answers 200', async () => {
    const res = await patch({
      supplierDeliveryDate2: '',
      supplierDeliveryDate3: '',
      supplierDeliveryDate4: '',
    });
    expect(res.status).toBe(200);
    expect(po().supplier_delivery_date_2).toBeNull();
    expect(po().supplier_delivery_date_3).toBeNull();
    expect(po().supplier_delivery_date_4).toBeNull();
  });

  it('still writes a real date, and leaves an unsent column alone', async () => {
    const before = po().po_date;
    const res = await patch({ supplierDeliveryDate2: '2026-10-01' });
    expect(res.status).toBe(200);
    expect(po().supplier_delivery_date_2).toBe('2026-10-01');
    expect(po().po_date).toBe(before);
  });
});
