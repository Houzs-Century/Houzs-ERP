// Owner ruling 2026-09-14: 「我的 Sales Invoice 开了，正常上游的单就锁了」. Once a live
// Sales Invoice / Delivery Return exists, the DO header's customer, address,
// contact and commercial fields are LOCKED — superseding the 2026-08-20 field-level
// rule that left addresses, phone, dates and notes editable. Only the
// dispatch-execution fields (driver, vehicle, expected delivery, delivery times)
// stay open; the salesperson locks too (「下游开了 上游就locked了啊」). The rule lives
// in shared/do-header-lock.ts.
//
// This drives the REAL header PATCH through the fake PostgREST client with a
// downstream SI present (a sales_invoices row on the DO, which is what
// doHasDownstream counts) and asserts both halves.
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
      branding: 'Houzs', notes: 'original', note: null, customer_delivery_date: '2026-09-01',
      phone: '012-345 6789', address1: '1 Jalan Lama', city: 'Petaling Jaya', postcode: '46000',
      customer_state: 'Selangor', email: 'a@x.test', emergency_contact_name: 'Ben',
      do_date: '2026-08-30', driver_name: 'Ali', vehicle: 'WXX 1', arrival_at: null,
      salesperson_id: 'sp-1', expected_delivery_at: '2026-09-02',
    }, {
      id: 'do-2', do_number: 'DO-2608-002', status: 'DISPATCHED', company_id: 1,
      debtor_name: 'Carol', address1: 'Old road', phone: '+60123456789',
    }],
    // A live Sales Invoice on this DO → doHasDownstream() is true.
    sales_invoices: [
      { id: 'si-1', delivery_order_id: 'do-1', status: 'SENT', company_id: 1 },
      // A CANCELLED invoice does not lock do-2.
      { id: 'si-2', delivery_order_id: 'do-2', status: 'CANCELLED', company_id: 1 },
    ],
    delivery_returns: [],
    entity_audit_log: [],
  }),
  { rpc: async () => ({ data: true, error: null }) },
);

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const doRow = (i = 0) => (sb.tables.delivery_orders[i] ?? {}) as Row;

const CALLER = {
  id: '7', email: 'ops@houzs.test', app_metadata: {},
  user_metadata: { name: 'Ops' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { deliveryOrdersMfg } = await import('./delivery-orders-mfg');

async function patch(body: Record<string, unknown>, id = 'do-1') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as never);
    await next();
  });
  app.route('/', deliveryOrdersMfg);
  return app.request(`/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('PATCH delivery order header — locked once a live SI exists (owner 2026-09-14)', () => {
  it.each([
    ['notes', { notes: 'updated remark' }, 'notes'],
    ['note', { note: 'new note' }, 'note'],
    ['phone', { phone: '0199998888' }, 'phone'],
    ['address', { address1: '9 Jalan Baru' }, 'address1'],
    ['city', { city: 'Shah Alam' }, 'city'],
    ['state', { customerState: 'Johor' }, 'customer_state'],
    ['postcode', { postcode: '40000' }, 'postcode'],
    ['email', { email: 'b@x.test' }, 'email'],
    ['emergency contact', { emergencyContactName: 'Dan' }, 'emergency_contact_name'],
    ['customer delivery date', { customerDeliveryDate: '2026-09-20' }, 'customer_delivery_date'],
    ['DO date', { doDate: '2026-09-03' }, 'do_date'],
    ['customer', { debtorName: 'Bob' }, 'debtor_name'],
    ['currency', { currency: 'USD' }, 'currency'],
    ['sales location', { salesLocation: 'JB' }, 'sales_location'],
    ['branding', { branding: 'Other' }, 'branding'],
    ['salesperson', { salespersonId: 'sp-2' }, 'salesperson_id'],
  ])('refuses a %s change with 409 do_identity_locked and writes nothing', async (_n, body, col) => {
    const beforeVal = doRow()[col];
    const res = await patch(body);
    expect(res.status).toBe(409);
    const j = await res.json() as { error: string; fields: string[]; message: string };
    expect(j.error).toBe('do_identity_locked');
    expect(j.fields).toEqual([col]);
    expect(j.message).toMatch(/Sales Invoice or Delivery Return/);
    expect(doRow()[col]).toBe(beforeVal);
  });

  it.each([
    ['driver', { driverName: 'Abu' }, 'driver_name', 'Abu'],
    ['vehicle', { vehicle: 'VBB 2' }, 'vehicle', 'VBB 2'],
    ['arrival (Mark arrived)', { arrivalAt: '2026-09-14T03:00:00.000Z' }, 'arrival_at', '2026-09-14T03:00:00.000Z'],
    ['expected delivery date', { expectedDeliveryAt: '2026-09-05' }, 'expected_delivery_at', '2026-09-05'],
  ])('still saves a %s change with an SI present', async (_n, body, col, val) => {
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(doRow()[col]).toBe(val);
  });

  it('a full form re-send of UNCHANGED values (legacy phone format, dated day) is not a change', async () => {
    const res = await patch({
      driverName: 'Ali-2', phone: '012-345 6789', customerDeliveryDate: '2026-09-01',
      debtorName: 'Alice', address1: '1 Jalan Lama', note: '', notes: 'original',
    });
    expect(res.status).toBe(200);
    expect(doRow().driver_name).toBe('Ali-2');
  });

  it('a DO whose only invoice is CANCELLED stays fully editable', async () => {
    const res = await patch({ address1: 'New road', phone: '0177776666' }, 'do-2');
    expect(res.status).toBe(200);
    expect(doRow(1).address1).toBe('New road');
  });
});
