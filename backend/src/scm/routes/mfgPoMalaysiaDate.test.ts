// A PO raised at 01:30 Malaysia time on 1 Dec is 17:30 UTC on 30 Nov. The
// Worker clock is UTC, so the PO date (column default now()) and the month in
// the PO number (getMonth()) both landed in November. Drives the real create
// handler through the fake PostgREST client, as mfgPoBlankExpectedAt.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
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

describe('POST mfg purchase order — Malaysian date', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('dates and numbers a PO made at 01:30 on 1 Dec (Malaysia) under December', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-30T17:30:00Z'));
    const res = await post({ supplierId: 'sup-1', purchaseLocationId: 'loc-1' });
    expect(res.status).toBe(201);
    expect(lastPo().po_date).toBe('2026-12-01');
    expect(String(lastPo().po_number)).toContain('2612');
  });

  it('keeps a PO date the buyer typed', async () => {
    const res = await post({ supplierId: 'sup-1', purchaseLocationId: 'loc-1', poDate: '2026-10-15' });
    expect(res.status).toBe(201);
    expect(lastPo().po_date).toBe('2026-10-15');
  });
});
