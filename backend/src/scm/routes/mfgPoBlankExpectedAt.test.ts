// Owner 2026-08-20 ("越松越好"): opening a PO must NOT be blocked by a missing
// Expected Delivery date. Before this change createMfgPurchaseOrderHandler
// answered 400 {"error":"expected_at_required"} the moment the field was blank
// — the one pure-date rule that could stop a PO being raised. The rule now
// mirrors po_date: a blank defaults to today (it still fans out to per-line
// delivery date downstream), never a 400. Purchase Location stays required.
//
// This drives the REAL create handler through the fake PostgREST client (same
// seam as mfgPoBlankDate.test.ts) and asserts on the header row that reached the
// database — because the handler calling `dateOrNull(x) ?? todayMyt()` is a
// different fact from the helpers existing. Against the pre-change handler the
// first test gets 400 and fails.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import { todayMyt } from '../lib/my-time';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_orders: [],
  purchase_order_items: [],
  grns: [],
  app_config: [],
  entity_audit_log: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const lastPo = () => (sb.tables.purchase_orders[sb.tables.purchase_orders.length - 1] ?? {}) as Row;

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function post(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST mfg purchase order — blank Expected Delivery', () => {
  it('accepts a PO with NO expected delivery date and stamps today (not a 400)', async () => {
    const res = await post({ supplierId: 'sup-1', purchaseLocationId: 'loc-1' });
    expect(res.status).toBe(201);
    expect(lastPo().expected_at).toBe(todayMyt());
  });

  it('still honours an explicit expected delivery date', async () => {
    const res = await post({
      supplierId: 'sup-1', purchaseLocationId: 'loc-1', expectedAt: '2026-12-25',
    });
    expect(res.status).toBe(201);
    expect(lastPo().expected_at).toBe('2026-12-25');
  });

  it('still rejects a missing Purchase Location (that one stays required)', async () => {
    const res = await post({ supplierId: 'sup-1' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'purchase_location_id_required' });
  });
});
