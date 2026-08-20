// Owner 2026-08-20 (§8 GAP-1): field-level header locks for the consignment
// siblings. PCO (mirrors PO) and CN (mirrors DO) had a WHOLE-doc lock that is now
// field-level; PC Receive (like GRN) had NO header guard at all and gains one.
// Each drives the REAL header PATCH through the fake PostgREST client with a live
// child present and asserts: own-stage fields save; an inherited field 409s.
//
// One shared fake for all three routers: their supabaseAuth middleware overrides
// c.supabase with getSupabaseService(), so the mock (not c.set) is the seam, and a
// module-level vi.mock can only return one client.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const sb = Object.assign(
  fakeSb({
    purchase_consignment_orders: [{ id: 'pco-1', pc_number: 'PCO-1', status: 'SUBMITTED', company_id: 1, supplier_id: 'sup-1', currency: 'MYR', purchase_location_id: 'loc-1', notes: 'orig' }],
    purchase_consignment_receives: [
      { id: 'pcr-x', purchase_consignment_order_id: 'pco-1', status: 'POSTED', company_id: 1 }, // PCO's child
      { id: 'pcr-1', receive_number: 'PCR-1', status: 'POSTED', company_id: 1, supplier_id: 'sup-1', currency: 'MYR', received_at: '2026-08-10', delivery_note_ref: 'DN', notes: 'orig' },
    ],
    purchase_consignment_receive_items: [{ id: 'li', pc_receive_id: 'pcr-1', returned_qty: 2 }], // PCR's child
    consignment_delivery_orders: [{ id: 'cn-1', do_number: 'CN-1', status: 'DISPATCHED', company_id: 1, debtor_code: 'C-1', debtor_name: 'Alice', currency: 'MYR', sales_location: 'PJ', branding: 'Houzs', notes: 'orig' }],
    consignment_delivery_returns: [{ id: 'cr-x', consignment_do_id: 'cn-1', status: 'RECEIVED', company_id: 1 }], // CN's child
    entity_audit_log: [],
    app_config: [],
  }),
  { rpc: async () => ({ data: true, error: null }) },
);

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'ops@houzs.test', app_metadata: {},
  user_metadata: { name: 'Ops' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { purchaseConsignmentOrders } = await import('./purchase-consignment-orders');
const { purchaseConsignmentReceives } = await import('./purchase-consignment-receives');
const { consignmentNotes } = await import('./consignment-notes');

function patch(router: unknown, path: string, body: Record<string, unknown>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => { c.set('user', CALLER); c.set('companyId', 1); await next(); });
  app.route('/', router as never);
  return app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const table = (t: string, id: string) => (sb.tables[t].find((r: Row) => r.id === id) ?? {}) as Row;

describe('PCO header — field-level lock (mirrors PO)', () => {
  it('own-stage notes save with a PC Receive present', async () => {
    const res = await patch(purchaseConsignmentOrders, '/pco-1', { notes: 'new-pco' });
    expect(res.status).toBe(200);
    expect(table('purchase_consignment_orders', 'pco-1').notes).toBe('new-pco');
  });
  it('supplier change refused (409 pco_identity_locked)', async () => {
    const res = await patch(purchaseConsignmentOrders, '/pco-1', { supplierId: 'sup-2' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'pco_identity_locked' });
    expect(table('purchase_consignment_orders', 'pco-1').supplier_id).toBe('sup-1');
  });
});

describe('PC Receive header — inherited-field lock (new guard, like GRN)', () => {
  it('own-stage notes save with a PC Return present', async () => {
    const res = await patch(purchaseConsignmentReceives, '/pcr-1', { notes: 'new-pcr' });
    expect(res.status).toBe(200);
    expect(table('purchase_consignment_receives', 'pcr-1').notes).toBe('new-pcr');
  });
  it('currency change refused (409 pc_receive_identity_locked)', async () => {
    const res = await patch(purchaseConsignmentReceives, '/pcr-1', { currency: 'USD' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'pc_receive_identity_locked' });
    expect(table('purchase_consignment_receives', 'pcr-1').currency).toBe('MYR');
  });
});

describe('CN header — field-level lock (mirrors DO)', () => {
  it('own-stage notes save with a Consignment Return present', async () => {
    const res = await patch(consignmentNotes, '/cn-1', { notes: 'new-cn' });
    expect(res.status).toBe(200);
    expect(table('consignment_delivery_orders', 'cn-1').notes).toBe('new-cn');
  });
  it('customer change refused (409 cn_identity_locked)', async () => {
    const res = await patch(consignmentNotes, '/cn-1', { debtorName: 'Bob' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'cn_identity_locked' });
    expect(table('consignment_delivery_orders', 'cn-1').debtor_name).toBe('Alice');
  });
});
