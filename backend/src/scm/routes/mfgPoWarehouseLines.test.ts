// Regression (sister fix Conts-ERP #783): changing a PO's ship-to warehouse
// updated the header only. The GRN made from the outstanding-lines picker
// receives into each LINE's warehouse, the GRN made from the PO uses the
// header's, so the same PO's goods went to two warehouses depending on the button.
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
/* The header PATCH needs the version the editor loaded (sister review G6). */
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
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(withVersion(body)),
  });
}

const line = (id: string) => (sb.tables.purchase_order_items.find((r) => r.id === id) ?? {}) as Row;
const header = () => sb.tables.purchase_orders[0] as Row;

const l = (id: string, company_id: number, warehouse_id: string | null, received_qty = 0) => ({
  id, purchase_order_id: 'po-1', company_id, item_code: id, qty: 2, received_qty, unit_price_sen: 0, discount_sen: 0,
  warehouse_id, delivery_date: '2026-10-10', line_delivery_date_overridden: false,
});

beforeEach(() => {
  sb.tables.purchase_orders = [{
    id: 'po-1', po_number: 'PO-2611-001', status: 'SUBMITTED', company_id: 1, updated_at: '2026-11-01T02:00:00.123456+00:00',
    po_date: '2026-11-01', expected_at: '2026-11-10', currency: 'MYR', notes: null,
    supplier_id: 'sup-1', purchase_location_id: 'wh-kl',
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  }];
  sb.tables.purchase_order_items = [
    l('a', 1, 'wh-kl'),
    l('b', 1, 'wh-kl'),
    // Deliberately set to another warehouse: keeps it.
    l('own', 1, 'wh-pg'),
    // No own warehouse: already follows the header.
    l('none', 1, null),
    // Another company's row on the same PO id is never touched.
    l('other', 2, 'wh-kl'),
  ];
});

describe('PATCH mfg purchase order header: a new ship-to warehouse moves the lines', () => {
  it('moves every line that sat on the old header warehouse', async () => {
    const res = await patch({ purchaseLocationId: 'wh-jb' });
    expect(res.status).toBe(200);
    expect(header().purchase_location_id).toBe('wh-jb');
    expect(line('a').warehouse_id).toBe('wh-jb');
    expect(line('b').warehouse_id).toBe('wh-jb');
  });

  it('leaves a line set to another warehouse, a line with none, and another company\'s line alone', async () => {
    await patch({ purchaseLocationId: 'wh-jb' });
    expect(line('own').warehouse_id).toBe('wh-pg');
    expect(line('none').warehouse_id).toBeNull();
    expect(line('other').warehouse_id).toBe('wh-kl');
  });

  it('refuses, and changes nothing, when goods were already received on a line of the old warehouse', async () => {
    sb.tables.purchase_order_items = [l('a', 1, 'wh-kl'), l('got', 1, 'wh-kl', 1)];
    const res = await patch({ purchaseLocationId: 'wh-jb' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('po_lines_received');
    expect(body.message).toContain('got');
    expect(header().purchase_location_id).toBe('wh-kl');
    expect(line('a').warehouse_id).toBe('wh-kl');
  });

  it('a save that re-sends the same warehouse moves nothing', async () => {
    await patch({ purchaseLocationId: 'wh-kl', notes: 'remark' });
    expect(line('own').warehouse_id).toBe('wh-pg');
    expect(line('a').warehouse_id).toBe('wh-kl');
  });
});
