/* /control-check must report a payment that no longer agrees with its entry.
 *
 * WHY. `PATCH /:docNo/payments/:id` writes the payment row and never touches
 * the general ledger — it recomputes the invoice's paid amount, queues an
 * AutoCount edit, and stops. So an edited payment silently leaves its journal
 * entry behind. Nothing has caught this because almost nothing is editable:
 * `paymentRowMutable` allows a change only on the day the payment was keyed.
 * Measured on production 2026-09-10, that accident is the only reason the
 * count of amount disagreements is zero.
 *
 * The owner has now confirmed with management that FINANCE should be able to
 * correct a mis-keyed payment, which opens that window. This check has to see
 * the divergence before that happens, so these cases drive the REAL route
 * through the fake PostgREST client.
 *
 * They also pin the neighbours the check must not disturb: an `imported` row
 * (the poster skips it, so its entry was never written from it), a payment
 * with no active entry (that is the UNBOOKED card's finding, and reporting it
 * here would show the owner one payment twice), and an entry whose narration
 * is not the poster's shape (nothing to compare a method against, so no
 * method claim is made).
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const je = (source_doc_no: string, over: Record<string, unknown> = {}) => ({
  id: `je-${source_doc_no}`, je_no: `JE-${source_doc_no}`, company_id: 1,
  source_type: 'SOPAY', source_doc_no, entry_date: '2026-09-01',
  posted: true, reversed: false, total_debit_sen: 150_000, total_credit_sen: 150_000,
  narration: 'Payment cash on HS-SO-2609-001', ...over,
});

const pay = (id: string, over: Record<string, unknown> = {}) => ({
  id, company_id: 1, so_doc_no: 'HS-SO-2609-001', paid_at: '2026-09-01',
  amount_sen: 150_000, method: 'cash', ...over,
});

const sb = fakeSb({
  acc_account_roles: [],
  v_gl_entries: [],
  sales_invoices: [],
  purchase_invoices: [],
  ap_invoices: [],
  sales_invoice_payments: [],
  journal_entries: [
    je('agree'),
    je('amount'),
    je('date'),
    je('method'),
    je('reversed-away', { reversed: true }),
    je('foreign-narration', { narration: 'Imported from AutoCount' }),
    je('imported-row'),
  ],
  mfg_sales_order_payments: [
    pay('agree'),
    pay('amount', { amount_sen: 199_000 }),
    pay('date', { paid_at: '2026-09-04' }),
    pay('method', { method: 'merchant' }),
    /* Its entry is reversed, so it has no ACTIVE entry — the unbooked card
       speaks for this one, not this check. */
    pay('reversed-away', { amount_sen: 1 }),
    /* The narration is not the poster's, so the method cannot be read and
       must not be guessed at. Everything else agrees. */
    pay('foreign-narration', { method: 'merchant' }),
    /* The poster skips `imported` rows outright. */
    pay('imported-row', { method: 'imported', amount_sen: 1 }),
    /* Never booked at all — the unbooked card's row. */
    pay('never-booked', { amount_sen: 42 }),
  ],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'acct@houzs.test', app_metadata: {},
  user_metadata: { name: 'Acct' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { accounting } = await import('./accounting');

type DriftRow = { id: string; docNo: string; jeNo: string; fields: string[]; paymentAmountSen: number; entryAmountSen: number; paidOn: string; entryDate: string; paymentMethod: string; entryMethod: string | null };

async function paymentDrift() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  app.route('/', accounting);
  const res = await app.request('/control-check');
  expect(res.status).toBe(200);
  const body = await res.json() as { paymentDrift: { rows: DriftRow[]; ok: boolean; scanned: number; error?: string } };
  return body.paymentDrift;
}

describe('/control-check — a payment that disagrees with its journal entry', () => {
  it('reports exactly the three that moved', async () => {
    const d = await paymentDrift();
    expect(d.error).toBeUndefined();
    expect(d.ok).toBe(false);
    expect(d.rows.map((r) => r.id).sort()).toEqual(['amount', 'date', 'method']);
  });

  it('names the money on both sides, so the difference can be read', async () => {
    const row = (await paymentDrift()).rows.find((r) => r.id === 'amount')!;
    expect(row.fields).toEqual(['amount']);
    expect(row.paymentAmountSen).toBe(199_000);
    expect(row.entryAmountSen).toBe(150_000);
    expect(row.docNo).toBe('HS-SO-2609-001');
    expect(row.jeNo).toBe('JE-amount');
  });

  it('names the date on both sides', async () => {
    const row = (await paymentDrift()).rows.find((r) => r.id === 'date')!;
    expect(row.fields).toEqual(['date']);
    expect(row.paidOn).toBe('2026-09-04');
    expect(row.entryDate).toBe('2026-09-01');
  });

  it('names a method change — the money is sitting in the wrong account', async () => {
    const row = (await paymentDrift()).rows.find((r) => r.id === 'method')!;
    expect(row.fields).toEqual(['method']);
    expect(row.paymentMethod).toBe('merchant');
    expect(row.entryMethod).toBe('cash');
  });

  it('leaves the neighbours alone', async () => {
    const ids = (await paymentDrift()).rows.map((r) => r.id);
    expect(ids).not.toContain('reversed-away');
    expect(ids).not.toContain('foreign-narration');
    expect(ids).not.toContain('imported-row');
    expect(ids).not.toContain('never-booked');
    expect(ids).not.toContain('agree');
  });

  it('says how many entries it read, so a clean answer is not an empty one', async () => {
    /* Six ACTIVE SOPAY entries — the reversed one is not read. */
    expect((await paymentDrift()).scanned).toBe(6);
  });
});
