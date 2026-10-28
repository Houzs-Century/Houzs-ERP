// Owner 2026-08-20: "开 PO 如果没有变体，供应商怎么知道要订什么" — CONFIRMING a
// PO must require the core variant axes on every sofa/bedframe goods line, the
// same way the PO form already blocks it. The form is defense in depth; a
// direct-API PATCH /:id/confirm bypassed it. This drives the REAL confirm
// handler through the fake PostgREST client and asserts:
//   1. an incomplete sofa line refuses (422 variants_required) and the message
//      lists EVERY incomplete line at once (never one-at-a-time);
//   2. a complete line confirms (status → SUBMITTED);
//   3. Special Orders is NOT an axis, so a line whose only "variant" is a
//      special order still confirms — it stays optional by design.
//
// The rule itself (missingVariantAxes) is unit-tested in shared/so-variant-rule;
// this pins the WIRING — the handler calling it on confirm.
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const SOFA_COMPLETE = { seatHeight: '20', fabricCode: 'F-101' };
const SOFA_INCOMPLETE = { fabricCode: 'F-101' }; // no seat height

const sb = fakeSb({
  purchase_orders: [
    { id: 'po-bad', po_number: 'PO-2608-900', status: 'DRAFT', company_id: 1, purchase_location_id: 'loc-1' },
    { id: 'po-ok', po_number: 'PO-2608-901', status: 'DRAFT', company_id: 1, purchase_location_id: 'loc-1' },
    { id: 'po-spec', po_number: 'PO-2608-902', status: 'DRAFT', company_id: 1, purchase_location_id: 'loc-1' },
  ],
  purchase_order_items: [
    { id: 'i1', purchase_order_id: 'po-bad', item_code: 'SOFA-A', item_group: 'sofa', variants: SOFA_INCOMPLETE, warehouse_id: 'loc-1' },
    { id: 'i2', purchase_order_id: 'po-bad', item_code: 'SOFA-B', item_group: 'sofa', variants: {}, warehouse_id: 'loc-1' },
    { id: 'i3', purchase_order_id: 'po-ok', item_code: 'SOFA-A', item_group: 'sofa', variants: SOFA_COMPLETE, warehouse_id: 'loc-1' },
    // A plain accessory with only a special order — no required axes, must pass.
    { id: 'i4', purchase_order_id: 'po-spec', item_code: 'ACC-1', item_group: 'accessory', variants: { specials: ['CUSTOM-LOGO'] }, warehouse_id: 'loc-1' },
  ],
  grns: [],
  app_config: [],
  entity_audit_log: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const poRow = (id: string) => (sb.tables.purchase_orders.find((p) => p.id === id) ?? {}) as Row;

const CALLER = {
  id: '7', email: 'buyer@houzs.test', app_metadata: {},
  user_metadata: { name: 'Buyer' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { mfgPurchaseOrders } = await import('./mfg-purchase-orders');

async function confirm(id: string) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', mfgPurchaseOrders);
  return app.request(`/${id}/confirm`, { method: 'PATCH', headers: { 'content-type': 'application/json' } });
}

describe('PATCH mfg purchase order /confirm — variant gate', () => {
  it('refuses an incomplete PO and lists EVERY incomplete line at once', async () => {
    const res = await confirm('po-bad');
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('variants_required');
    // both incomplete lines named in one message — not one-at-a-time
    expect(body.message).toContain('SOFA-A');
    expect(body.message).toContain('SOFA-B');
    expect(body.message).toContain('Seat Size'); // the missing axis label
    expect(poRow('po-bad').status).toBe('DRAFT'); // not confirmed
  });

  it('confirms a PO whose lines carry the required variants', async () => {
    const res = await confirm('po-ok');
    expect(res.status).toBe(200);
    expect(poRow('po-ok').status).toBe('SUBMITTED');
  });

  it('confirms a line whose only option is a Special Order (specials stay optional)', async () => {
    const res = await confirm('po-spec');
    expect(res.status).toBe(200);
    expect(poRow('po-spec').status).toBe('SUBMITTED');
  });
});
