// Owner 2026-08-20 (§8 GAP-1): the DO header used to freeze WHOLESALE once a Sales
// Invoice / Delivery Return existed. It is now FIELD-LEVEL: only the columns the
// child snapshots (customer + currency + location + branding) freeze; the DO's own
// delivery dates, dispatch/POD, addresses and notes stay editable. This drives the
// REAL header PATCH through the fake PostgREST client with a downstream SI present
// (a sales_invoices row on the DO, which is what doHasDownstream counts) and
// asserts both halves.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = Object.assign(
  fakeSb({
    delivery_orders: [{
      id: 'do-1', do_number: 'DO-2608-001', status: 'DISPATCHED', company_id: 1,
      debtor_code: 'C-1', debtor_name: 'Alice', currency: 'MYR', sales_location: 'PJ',
      branding: 'Houzs', notes: 'original', customer_delivery_date: '2026-09-01',
    }],
    // A live Sales Invoice on this DO → doHasDownstream() is true.
    sales_invoices: [{ id: 'si-1', delivery_order_id: 'do-1', status: 'SENT', company_id: 1 }],
    delivery_returns: [],
    entity_audit_log: [],
  }),
  { rpc: async () => ({ data: true, error: null }) },
);

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const doRow = () => (sb.tables.delivery_orders[0] ?? {}) as Row;

const CALLER = {
  id: '7', email: 'ops@houzs.test', app_metadata: {},
  user_metadata: { name: 'Ops' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { deliveryOrdersMfg } = await import('./delivery-orders-mfg');

async function patch(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', deliveryOrdersMfg);
  return app.request('/do-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PATCH delivery order header — field-level lock with a downstream SI', () => {
  it('lets own-stage fields (notes) save even with an SI present', async () => {
    const res = await patch({ notes: 'updated remark' });
    expect(res.status).toBe(200);
    expect(doRow().notes).toBe('updated remark');
  });

  it('refuses a customer change (the SI was billed to it) and writes nothing', async () => {
    const res = await patch({ debtorName: 'Bob' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'do_identity_locked' });
    expect(doRow().debtor_name).toBe('Alice');
  });

  it('refuses a currency change with an SI present', async () => {
    const res = await patch({ currency: 'USD' });
    expect(res.status).toBe(409);
    expect(doRow().currency).toBe('MYR');
  });
});
