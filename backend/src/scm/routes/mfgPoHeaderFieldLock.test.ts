// Owner 2026-08-20 (§8 GAP-1): the PO header used to freeze WHOLESALE once a GRN
// existed — even a supplier remark or a pushed delivery date was refused. It is
// now FIELD-LEVEL: only the columns a GRN inherits (supplier / currency /
// purchase location) freeze; the PO's own dates + notes stay editable. This
// drives the REAL header PATCH through the fake PostgREST client, with a
// non-cancelled GRN present, and asserts both halves.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = fakeSb({
  purchase_orders: [{
    id: 'po-1', po_number: 'PO-2608-001', status: 'SUBMITTED', company_id: 1,
    po_date: '2026-08-01', expected_at: '2026-09-01', currency: 'MYR',
    notes: 'original', supplier_id: 'sup-1', purchase_location_id: 'loc-1',
    supplier_delivery_date_2: null, supplier_delivery_date_3: null, supplier_delivery_date_4: null,
  }],
  // A live (non-cancelled) GRN makes po-1 a parent with a child.
  grns: [{ id: 'grn-1', purchase_order_id: 'po-1', status: 'DRAFT', company_id: 1 }],
  purchase_order_items: [],
  app_config: [],
  entity_audit_log: [],
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
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  return app.request('/po-1', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PATCH mfg purchase order header — field-level lock with a GRN present', () => {
  it('lets PO-own fields (notes, expected date) save even though a GRN exists', async () => {
    const res = await patch({ notes: 'updated remark', expectedAt: '2026-10-15' });
    expect(res.status).toBe(200);
    expect(po().notes).toBe('updated remark');
    expect(po().expected_at).toBe('2026-10-15');
  });

  it('refuses a supplier change (inherited by the GRN) and writes nothing', async () => {
    const res = await patch({ supplierId: 'sup-2' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'po_identity_locked' });
    expect(po().supplier_id).toBe('sup-1');
  });

  it('refuses a currency change with a GRN present', async () => {
    const res = await patch({ currency: 'USD' });
    expect(res.status).toBe(409);
    expect(po().currency).toBe('MYR');
  });
});
