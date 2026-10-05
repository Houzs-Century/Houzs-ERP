// Owner rule: the Consignment Order header delivery date behaves like the SO's.
// A header Delivery Date CHANGE overwrites every line's date and clears the
// per-line override flag; a save that leaves the date unchanged touches no line
// (the CO page sends every header field on every save).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = Object.assign(fakeSb({}), { rpc: async () => ({ data: true, error: null }) });

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'ops@houzs.test', app_metadata: {},
  user_metadata: { name: 'Ops' }, aud: 'authenticated', created_at: '', permissions: ['*'],
} as unknown as User;

const { consignmentOrders } = await import('./consignment-orders');

function patch(body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    await next();
  });
  app.route('/', consignmentOrders as never);
  return app.request('/CO-1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const line = (id: string) => sb.tables.consignment_sales_order_items.find((r: Row) => r.id === id) as Row;

beforeEach(() => {
  sb.tables.consignment_sales_orders = [{
    doc_no: 'CO-1', company_id: 1, status: 'CONFIRMED', note: 'orig',
    processing_date: '2027-01-05', customer_delivery_date: '2027-01-10',
  }];
  sb.tables.consignment_sales_order_items = [
    { id: 'auto', doc_no: 'CO-1', company_id: 1, line_delivery_date: '2027-01-10', line_delivery_date_overridden: false },
    { id: 'hand', doc_no: 'CO-1', company_id: 1, line_delivery_date: '2027-01-20', line_delivery_date_overridden: true },
  ];
  sb.tables.entity_audit_log = [];
  sb.tables.app_config = [];
});

describe('CO header delivery date cascade (same as SO)', () => {
  it('a changed header date overwrites every line, overridden ones included, and clears the flag', async () => {
    const res = await patch({ customerDeliveryDate: '2027-01-15' });
    expect(res.status).toBe(200);
    for (const id of ['auto', 'hand']) {
      expect(line(id).line_delivery_date).toBe('2027-01-15');
      expect(line(id).line_delivery_date_overridden).toBe(false);
    }
  });

  it('an unchanged header date (full-payload save) leaves a hand-set line alone', async () => {
    const res = await patch({ note: 'edited', customerDeliveryDate: '2027-01-10' });
    expect(res.status).toBe(200);
    expect(line('hand').line_delivery_date).toBe('2027-01-20');
    expect(line('hand').line_delivery_date_overridden).toBe(true);
  });
});
