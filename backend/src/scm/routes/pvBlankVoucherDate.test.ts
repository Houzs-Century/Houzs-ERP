import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

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

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const { paymentVouchers } = await import('./payment-vouchers');

const DRAFT = (): Row => ({
  id: 'pv-1', pv_number: 'HC-PV-2608-001', voucher_date: '2026-08-01',
  payee_name: 'Acme Timber', supplier_id: null, credit_account_code: '100-0000',
  currency: 'MYR', exchange_rate: 1, purpose: 'OTHER', notes: null,
  total_sen: 50000, status: 'DRAFT', posted_at: null,
  created_at: '2026-08-01T00:00:00Z', created_by: '7',
  updated_at: '2026-08-01T00:00:00Z', company_id: 1,
});

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
