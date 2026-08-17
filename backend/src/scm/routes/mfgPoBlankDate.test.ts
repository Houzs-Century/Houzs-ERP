// A blank optional date must be STORED AS NULL, not sent to Postgres as "".
//
// The production failure, 2026-08-17: PATCH /api/scm/mfg-purchase-orders/<id>
// with {"supplierDeliveryDate2":"","supplierDeliveryDate3":"","supplierDeliveryDate4":""}
// answered 500 {"error":"update_failed","reason":"invalid input syntax for type
// date: \"\""}. The same request with those keys null, or omitted, answered 200.
// Every Purchase Order that left the optional Supplier Date 2/3/4 blank — most
// of them — failed to save, and staff saw "Save failed - The system hit a
// problem."
//
// The unit rule lives in lib/date-coerce.test.ts. This one is about the WIRING:
// it drives the real PATCH handler and asserts what actually reached the
// database, because the coercion helper existing is not the same fact as the
// handler calling it. Against the pre-fix handler the stored value is "" and
// both cases below fail.
//
// The fake PostgREST does not type-check columns, so this test cannot reproduce
// the 500 itself — it pins the value that would have caused it.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_orders: [{
    id: 'po-1', po_number: 'PO-2608-001', status: 'SUBMITTED', company_id: 1,
    po_date: '2026-08-01', expected_at: '2026-09-01', currency: 'MYR',
    notes: null, supplier_id: 'sup-1', purchase_location_id: 'loc-1',
    supplier_delivery_date_2: '2026-09-10',
    supplier_delivery_date_3: null,
    supplier_delivery_date_4: null,
  }],
  grns: [],
  purchase_order_items: [],
  app_config: [],
  entity_audit_log: [],
});

/* supabaseAuth replaces whatever the caller set with the service client, so the
   fake has to be injected at that seam rather than through the context. */
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const po = () => (sb.tables.purchase_orders[0] ?? {}) as Row;

/* The global /api/* auth normally sets these; supabaseAuth reads `user` for the
   caller's identity and companyContext sets `companyId`. Both are stubbed here
   so the handler under test sees the same context a real request gives it. */
const CALLER = {
  id: '7',
  email: 'buyer@houzs.test',
  app_metadata: {},
  user_metadata: { name: 'Buyer' },
  aud: 'authenticated',
  created_at: '',
} as unknown as User;

async function patch(body: Record<string, unknown>) {
  const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');
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
    body: JSON.stringify(body),
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
