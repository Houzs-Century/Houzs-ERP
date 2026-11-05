/* HC-0180 (Syu, 2026-10-29): picking "To Send Delivery Date" on the Delivery
 * Planning row for 2990-SO-2610-005 answered "Not saved — That item could no
 * longer be found. Please refresh." while the HC row beside it saved fine.
 *
 * The board lists every ALLOWED company's orders (scopeToAllowedCompanies), but
 * PATCH /:type/:id/fields gated the document on the ACTIVE company
 * (scopeToCompany) — so a 2990 order picked while switched to Houzs 404'd. The
 * gate now widens to the caller's allowed companies, never beyond them.
 *
 * Route-level over the in-memory PostgREST fake, supabaseAuth stubbed to a
 * passthrough (same shape as mrp-lead-times.test.ts). */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

vi.mock('../middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));
// The fake has no `.or(...lt...)` for the edit-lease guard; the version CAS is not under test here.
vi.mock('../lib/so-generation', () => ({
  advanceSoGeneration: async (sb: SupabaseClient, docNo: string, patch: Record<string, unknown>) => {
    await sb.from('mfg_sales_orders').update(patch).eq('doc_no', docNo);
    return { applied: true };
  },
}));

const { deliveryPlanning } = await import('./delivery-planning');

const HOUZS = 1;
const S2990 = 2;
const CALLER = { id: 'staff-uuid', email: 'x@houzs.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as unknown as User;

let tables: Record<string, Array<Record<string, unknown>>>;

const so = (docNo: string, companyId: number) => ({
  doc_no: docNo,
  company_id: companyId,
  status: 'CONFIRMED',
  delivery_message_status: null,
});

function app(allowed: number[]) {
  const sb = fakeSb(tables);
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', HOUZS as Variables['companyId']);
    c.set('allowedCompanyIds', allowed as Variables['allowedCompanyIds']);
    c.set('supabase', sb as unknown as SupabaseClient);
    c.set('houzsUser', { id: 1, name: 'Syu', permissions_set: new Set(['*']), permissions: ['*'] } as unknown as Variables['houzsUser']);
    await next();
  });
  a.route('/delivery-planning', deliveryPlanning);
  return a;
}

const patch = (allowed: number[], docNo: string) =>
  app(allowed).request(`/delivery-planning/so/${docNo}/fields`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deliveryMessageStatus: 'To Send Delivery Date' }),
  }, {} as Env);

const statusOf = (docNo: string) =>
  tables.mfg_sales_orders!.find((r) => r.doc_no === docNo)!.delivery_message_status;

beforeEach(() => {
  tables = {
    mfg_sales_orders: [so('HC-SO-012330', HOUZS), so('2990-SO-2610-005', S2990)],
    delivery_orders: [],
  };
});

describe('PATCH /delivery-planning/so/:docNo/fields — cross-company board row', () => {
  it('saves a 2990 order while the caller is switched to Houzs', async () => {
    const res = await patch([HOUZS, S2990], '2990-SO-2610-005');
    expect(res.status).toBe(200);
    expect(statusOf('2990-SO-2610-005')).toBe('To Send Delivery Date');
  });

  it('still saves the active company order', async () => {
    const res = await patch([HOUZS, S2990], 'HC-SO-012330');
    expect(res.status).toBe(200);
    expect(statusOf('HC-SO-012330')).toBe('To Send Delivery Date');
  });

  it('refuses an order in a company the caller holds no grant for', async () => {
    const res = await patch([HOUZS], '2990-SO-2610-005');
    expect(res.status).toBe(404);
    expect(statusOf('2990-SO-2610-005')).toBeNull();
  });
});
