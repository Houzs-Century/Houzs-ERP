// Owner rule (6 Oct 2026, last edit wins, same as SO): a Consignment Order header
// Delivery Date CHANGE moves every line's date, hand-set ones included, except a
// line already on a live Consignment Note. A save that
// leaves the date unchanged touches no line (the CO page re-sends every field).
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
    { id: 'noted', doc_no: 'CO-1', company_id: 1, line_delivery_date: '2027-01-10', line_delivery_date_overridden: false },
    { id: 'voided', doc_no: 'CO-1', company_id: 1, line_delivery_date: '2027-01-10', line_delivery_date_overridden: false },
  ];
  sb.tables.consignment_delivery_orders = [
    { id: 'n1', company_id: 1, consignment_so_doc_no: 'CO-1', status: 'DRAFT' },
    { id: 'n0', company_id: 1, consignment_so_doc_no: 'CO-1', status: 'CANCELLED' },
  ];
  sb.tables.consignment_delivery_order_items = [
    { id: 'n1-a', company_id: 1, consignment_delivery_order_id: 'n1', consignment_so_item_id: 'noted' },
    { id: 'n0-a', company_id: 1, consignment_delivery_order_id: 'n0', consignment_so_item_id: 'voided' },
  ];
  sb.tables.entity_audit_log = [];
  sb.tables.app_config = [];
});

describe('CO header delivery date cascade', () => {
  it('last edit wins: a hand-set line takes the new header date and follows it again', async () => {
    expect((await patch({ customerDeliveryDate: '2027-01-15' })).status).toBe(200);
    expect(line('hand').line_delivery_date).toBe('2027-01-15');
    expect(line('hand').line_delivery_date_overridden).toBe(false);
  });

  it('a line on a live Consignment Note keeps its date', async () => {
    expect((await patch({ customerDeliveryDate: '2027-01-15' })).status).toBe(200);
    expect(line('noted').line_delivery_date).toBe('2027-01-10');
  });

  it('a plain line and a line only on a cancelled note follow the header', async () => {
    expect((await patch({ customerDeliveryDate: '2027-01-15' })).status).toBe(200);
    expect(line('auto').line_delivery_date).toBe('2027-01-15');
    expect(line('voided').line_delivery_date).toBe('2027-01-15');
  });

  it('a remark-only save (header date re-sent unchanged) moves no line', async () => {
    sb.tables.consignment_delivery_orders = [];
    sb.tables.consignment_delivery_order_items = [];
    sb.tables.consignment_sales_order_items.find((r: Row) => r.id === 'auto')!.line_delivery_date = '2027-01-12';
    expect((await patch({ note: 'edited', customerDeliveryDate: '2027-01-10' })).status).toBe(200);
    expect(line('auto').line_delivery_date).toBe('2027-01-12');
    expect(line('hand').line_delivery_date).toBe('2027-01-20');
    expect(line('hand').line_delivery_date_overridden).toBe(true);
  });
});
