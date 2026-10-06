// Owner 2026-10-06: when the PO header Delivery Date (expected_at) changes, every
// line's delivery_date follows, except (a) a hand-set line
// (line_delivery_date_overridden, set when a user saves a line date by hand) and
// (b) a line already fully received on a GRN (received_qty >= qty).
// Drives the REAL header PATCH through the fake PostgREST client.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({ purchase_orders: [], purchase_order_items: [], grns: [], app_config: [], entity_audit_log: [] });

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function patch(body: Record<string, unknown>, path = '/po-1') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  return app.request(path, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

const line = (id: string) => (sb.tables.purchase_order_items.find((r) => r.id === id) ?? {}) as Row;

beforeEach(() => {
  sb.tables.purchase_orders = [{
    id: 'po-1', po_number: 'PO-2610-001', status: 'PARTIALLY_RECEIVED', company_id: 1,
    po_date: '2026-10-01', expected_at: '2026-10-10', currency: 'MYR', notes: null,
    supplier_id: 'sup-1', purchase_location_id: 'loc-1',
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  }];
  const l = (id: string, company_id: number, qty: number, received_qty: number, delivery_date: string | null, overridden = false) => ({
    id, purchase_order_id: 'po-1', company_id, item_code: id, qty, received_qty, unit_price_sen: 0, discount_sen: 0,
    delivery_date, line_delivery_date_overridden: overridden,
  });
  sb.tables.purchase_order_items = [
    l('open', 1, 2, 0, '2026-10-10'),
    l('hand', 1, 1, 0, '2026-10-20', true),
    // A different date but NOT hand-set (e.g. built from SO lines with mixed dates): it follows.
    l('mixed', 1, 1, 0, '2026-10-25'),
    l('blank', 1, 1, 0, null),
    l('part', 1, 4, 1, '2026-10-10'),
    l('done', 1, 3, 3, '2026-10-10'),
    // Another company's line on the same PO id must never be touched.
    l('other', 2, 1, 0, '2026-10-10'),
  ];
});

describe('PATCH mfg purchase order header — Delivery Date cascades to lines', () => {
  it('moves every line that follows the old header date and is not fully received', async () => {
    const res = await patch({ expectedAt: '2026-11-05' });
    expect(res.status).toBe(200);
    expect(line('open').delivery_date).toBe('2026-11-05');
    expect(line('part').delivery_date).toBe('2026-11-05');
  });

  it('a hand-set line keeps its date and its flag', async () => {
    await patch({ expectedAt: '2026-11-05' });
    expect(line('hand').delivery_date).toBe('2026-10-20');
    expect(line('hand').line_delivery_date_overridden).toBe(true);
  });

  it('a line with a different date but no hand-set flag moves', async () => {
    await patch({ expectedAt: '2026-11-05' });
    expect(line('mixed').delivery_date).toBe('2026-11-05');
    expect(line('mixed').line_delivery_date_overridden).toBe(false);
  });

  it('a line with no date moves to the new header date', async () => {
    await patch({ expectedAt: '2026-11-05' });
    expect(line('blank').delivery_date).toBe('2026-11-05');
  });

  it('leaves a fully received line and another company\'s line alone', async () => {
    await patch({ expectedAt: '2026-11-05' });
    expect(line('done').delivery_date).toBe('2026-10-10');
    expect(line('other').delivery_date).toBe('2026-10-10');
  });

  it('does not touch lines when the header date was not sent', async () => {
    await patch({ notes: 'just a remark' });
    expect(line('open').delivery_date).toBe('2026-10-10');
    expect(line('hand').delivery_date).toBe('2026-10-20');
  });

  it('does not touch lines when the editor re-sends an UNCHANGED date with a notes edit', async () => {
    // PurchaseOrderDetail.tsx sends the whole header snapshot on every save.
    await patch({ notes: 'just a remark', expectedAt: '2026-10-10', poDate: '2026-10-01' });
    expect(line('hand').delivery_date).toBe('2026-10-20');
    expect(line('mixed').delivery_date).toBe('2026-10-25');
  });
});

describe('PATCH mfg purchase order line — a user-saved date marks the line hand-set', () => {
  it('a changed line date sets line_delivery_date_overridden', async () => {
    expect((await patch({ deliveryDate: '2026-10-18' }, '/po-1/items/open')).status).toBe(200);
    expect(line('open').delivery_date).toBe('2026-10-18');
    expect(line('open').line_delivery_date_overridden).toBe(true);
  });

  it('a date copied from the header (explicit flag false) does not', async () => {
    await patch({ deliveryDate: '2026-11-05', lineDeliveryDateOverridden: false }, '/po-1/items/open');
    expect(line('open').line_delivery_date_overridden).toBe(false);
  });

  it('a qty edit that re-sends the same date does not', async () => {
    await patch({ qty: 3, deliveryDate: '2026-10-10' }, '/po-1/items/open');
    expect(line('open').line_delivery_date_overridden).toBe(false);
  });
});
