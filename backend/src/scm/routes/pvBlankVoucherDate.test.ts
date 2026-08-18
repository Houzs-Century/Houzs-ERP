// A blank Voucher Date on a DRAFT PV must be REFUSED by name, never sent to
// Postgres as "" and never stored as NULL.
//
// scm.payment_vouchers.voucher_date is `date NOT NULL DEFAULT current_date`
// (mig 0081). PaymentVoucherDetail sends `voucherDate` on every save and
// DateField emits "" when the field is cleared, so `updates.voucher_date =
// body.voucherDate` handed Postgres a blank and answered
// 500 `invalid input syntax for type date: ""` — the same failure the PO header
// was raised for, in a file that already imported the coercion and used it
// correctly one screen away on the CREATE path.
//
// NULL is not the fix here: the column is NOT NULL, so it would trade an
// invalid-syntax 500 for a not-null 500. The handler refuses with 400
// `voucher_date_required`, matching payeeName and creditAccountCode directly
// above it.
//
// The fake PostgREST does not type-check columns, so this suite cannot
// reproduce the 500 itself — it pins the request that caused it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

/* The audit PRE-FLIGHT (`assertAuditWritable`) probes an RPC and refuses the
   whole save with 409 when it cannot answer — deliberately, so a change is
   never stored without its record of who made it. The fake has no rpc(), so it
   gets one that answers "writable"; without it every case here would 409 before
   reaching the date branch under test. */
const sb = Object.assign(
  fakeSb({
    payment_vouchers: [],
    payment_voucher_lines: [],
    pv_allocations: [],
    purchase_invoices: [],
    entity_audit_log: [],
    app_config: [],
  }),
  { rpc: async () => ({ data: true, error: null }) },
);

/* supabaseAuth swaps whatever the caller set for the service client, so the
   fake has to be injected at that seam rather than through the context. */
vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

/* Imported at module scope on purpose — awaited inside a test body, a router
   of this size charges its transform to testTimeout and the suite goes red
   only under the parallel load of a full run. */
const { paymentVouchers } = await import('./payment-vouchers');

const DRAFT = (): Row => ({
  id: 'pv-1', pv_number: 'HC-PV-2608-001', voucher_date: '2026-08-01',
  payee_name: 'Acme Timber', supplier_id: null, credit_account_code: '100-0000',
  currency: 'MYR', exchange_rate: 1, purpose: 'OTHER', notes: null,
  total_centi: 50000, status: 'DRAFT', posted_at: null,
  created_at: '2026-08-01T00:00:00Z', created_by: '7',
  updated_at: '2026-08-01T00:00:00Z', company_id: 1,
});

/* supabaseAuth derives `houzsUser` — and the permission set every SCM gate
   reads — from whatever the global /api/* auth left on `user`, so the harness
   sets THAT rather than houzsUser directly. The Houzs session user is not a
   Supabase User; the context slot is typed as one, which is the seam
   supabaseAuth exists to bridge. */
const CALLER = {
  id: 7, email: 'finance@houzs.test', name: 'Finance', permissions: ['*'],
} as unknown as User;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use('*', async (c, next) => {
  c.set('companyId', 1);
  c.set('user', CALLER);
  await next();
});
app.route('/', paymentVouchers);

const pv = () => (sb.tables.payment_vouchers[0] ?? {}) as Row;

const patch = (body: Record<string, unknown>) =>
  app.request('/pv-1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  sb.tables.payment_vouchers = [DRAFT()];
  sb.tables.entity_audit_log = [];
});

describe('PATCH payment voucher — blank voucher date', () => {
  it('refuses a cleared date by name and leaves the stored one alone', async () => {
    const res = await patch({ voucherDate: '' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'voucher_date_required' });
    expect(pv().voucher_date).toBe('2026-08-01');
  });

  it('still writes a real date', async () => {
    const res = await patch({ voucherDate: '2026-09-15' });
    expect(res.status).toBe(200);
    expect(pv().voucher_date).toBe('2026-09-15');
  });
});
