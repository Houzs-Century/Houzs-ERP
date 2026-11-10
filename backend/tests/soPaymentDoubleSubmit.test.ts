/* One press of Save = one payment, and a refused Save can be corrected.
 *
 * PRODUCTION, company 1 (check-half-done-documents, run 42808054032): the same
 * transfer was booked twice on HC-SO-2609-164 (2026-10-28, 2.1 s apart) and on
 * HC-SO-008674 (2026-11-06, 4.1 s apart). The forms send one Idempotency-Key
 * per payment intent; these tests pin the server half of that contract on the
 * REAL routers behind the REAL middleware (Postgres and the claim table are
 * stand-ins):
 *
 *   - the same key twice, in sequence or at once, books ONE payment
 *   - a refusal before the first write releases the key, so the corrected Save
 *     under the same key books it, instead of `idempotency_key_reused`
 *   - the same release on the SI payment and the two receipt creates. */
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { idempotency } from '../src/middleware/idempotency';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { todayMyt } from '../src/scm/lib/my-time';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { shiftIsoDay } from '../src/scm/shared/payment-slip-date';
import { mfgSalesOrders } from '../src/scm/routes/mfg-sales-orders';
import { salesInvoices } from '../src/scm/routes/sales-invoices';
import { receipts } from '../src/scm/routes/receipts';
import type { Env } from '../src/types';
import { claimStore } from './lib/idempotency-claim-store';

const CO = 1;
const SO = 'HC-SO-2609-164';
const TODAY = todayMyt();

const CHART: Row[] = [
  { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '509-0000', account_name: 'DEPOSIT PAY BY CUSTOMER', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
];

function harness(mount: (app: Hono<{ Bindings: Env }>) => void) {
  const tables: Record<string, Row[]> = {
    accounts: CHART.map((r) => ({ ...r })),
    acc_account_roles: [], acc_bank_letters: [], acc_numbering: [], acc_company_settings: [],
    acc_deposit_invoices: [], acc_official_receipts: [], acc_credit_notes: [], acc_credit_note_lines: [],
    acc_receipts: [], acc_receipt_lines: [],
    companies: [{ id: CO, code: 'HOUZS' }],
    customer_credits: [], entity_audit_log: [], journal_entries: [], journal_entry_lines: [],
    mfg_sales_orders: [{
      doc_no: SO, company_id: CO, status: 'CONFIRMED', debtor_name: 'Ah Meng', debtor_code: null, phone: '0123',
      customer_id: 'cust-1', salesperson_id: 'staff-1', access_staff_ids: null, open_to_all: true,
      local_total_sen: 500_000, updated_at: '2026-08-01T02:00:00Z',
    }],
    mfg_sales_order_payments: [],
    mfg_so_audit_log: [],
    pending_slip_uploads: [1, 2, 3].map((i) => ({ upload_session_id: `sess-${i}`, r2_key: `slips/${i}.jpg`, status: 'uploaded' })),
    sales_invoices: [{ id: 'si-1', company_id: CO, status: 'CANCELLED', invoice_number: 'HC-SI-2611-001', paid_sen: 0, salesperson_id: null }],
    sales_invoice_payments: [],
    staff: [],
  };
  const sb = fakeSb(tables);
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('userId' as never, 9 as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HOUZS' }] as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID, user_metadata: { name: 'Finance A' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Finance A', permissions_set: new Set<string>(['scm.payment_voucher.create']) } as never);
    await next();
  });
  app.use('*', idempotency);
  mount(app);
  return { app, tables };
}

/** One opened payment form = one key, for every press of its Save. */
const KEY = 'one-form-one-payment';
const post = (app: Hono<{ Bindings: Env }>, env: Env, path: string, body: unknown) =>
  app.request(`https://test.local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
    body: JSON.stringify(body),
  }, env);

const transfer = (over: Record<string, unknown> = {}) => ({
  paidAt: TODAY, method: 'transfer', onlineType: 'Bank Transfer', amountSen: 150_000, uploadSessionId: 'sess-1', ...over,
});

const soHarness = () => harness((app) => { app.route('/mfg-sales-orders', mfgSalesOrders as never); });
const payPath = `/mfg-sales-orders/${SO}/payments`;

describe('a Sales Order payment saved twice under one key', () => {
  it('a second press after the first answered replays it — one payment', async () => {
    const store = claimStore();
    const { app, tables } = soHarness();

    const first = await post(app, store.env, payPath, transfer());
    expect(first.status).toBe(201);
    const again = await post(app, store.env, payPath, transfer());
    expect(again.status).toBe(201);
    expect(again.headers.get('Idempotent-Replay')).toBe('true');

    expect(tables.mfg_sales_order_payments).toHaveLength(1);
    expect(((await again.json()) as { payment: { id: string } }).payment.id)
      .toBe(((await first.json()) as { payment: { id: string } }).payment.id);
  });

  it('two presses at the same moment book one payment', async () => {
    const store = claimStore();
    const { app, tables } = soHarness();

    const answers = await Promise.all([post(app, store.env, payPath, transfer()), post(app, store.env, payPath, transfer())]);
    /* Whichever loses the claim is answered as a replay or as still in flight — never run. */
    for (const r of answers) {
      const ok = r.status === 201 || (r.status === 409 && ((await r.clone().json()) as { error: string }).error === 'idempotency_in_flight');
      expect(ok).toBe(true);
    }
    expect(tables.mfg_sales_order_payments).toHaveLength(1);
  });
});

describe('a refused Sales Order payment can be corrected and saved under the same key', () => {
  it('a slip dated outside the window is refused, the date fixed, and the payment books', async () => {
    const store = claimStore();
    const { app, tables } = soHarness();

    const refused = await post(app, store.env, payPath, transfer({ paidAt: shiftIsoDay(TODAY, -15) }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe('slip_date_out_of_window');
    expect(tables.mfg_sales_order_payments).toHaveLength(0);
    expect(store.rows).toHaveLength(0);

    const corrected = await post(app, store.env, payPath, transfer());
    expect(((await corrected.json()) as { error?: string }).error).toBeUndefined();
    expect(corrected.status).toBe(201);
    expect(tables.mfg_sales_order_payments).toHaveLength(1);
  });

  it('a payment whose method is missing its sub-type is refused and then saved', async () => {
    const store = claimStore();
    const { app, tables } = soHarness();

    const refused = await post(app, store.env, payPath, transfer({ onlineType: null }));
    expect(refused.status).toBe(400);
    expect(store.rows).toHaveLength(0);

    const corrected = await post(app, store.env, payPath, transfer());
    expect(corrected.status).toBe(201);
    expect(tables.mfg_sales_order_payments).toHaveLength(1);
  });
});

describe('the same release on the other money-in creates', () => {
  it('a refused Sales Invoice payment frees the key', async () => {
    const store = claimStore();
    const { app, tables } = harness((a) => { a.route('/sales-invoices', salesInvoices as never); });
    const res = await post(app, store.env, '/sales-invoices/si-1/payments', { paidAt: TODAY, method: 'cash', amountSen: 10_000 });
    expect(res.status).toBe(409);
    expect(tables.sales_invoice_payments).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it('a refused sundry receipt frees the key', async () => {
    const store = claimStore();
    const { app, tables } = harness((a) => { a.route('/receipts', receipts as never); });
    const res = await post(app, store.env, '/receipts', { payerName: '', bankAccountCode: '320-0000', lines: [] });
    expect(res.status).toBe(400);
    expect(tables.acc_receipts).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  /* The mark must be taken back BEFORE the first write, or a failure after a
     write would release a key whose retry books the money a second time. */
  const src = (f: string) => readFileSync(new URL(`../src/scm/routes/${f}`, import.meta.url), 'utf8');
  const marksBefore = (file: string, mount: string, handler: string, firstWrite: string) => {
    const s = src(file);
    expect(s).toContain(mount);
    const body = s.slice(s.indexOf(`export const ${handler}`));
    expect(body.indexOf('writesFromHere(c)')).toBeGreaterThan(0);
    expect(body.indexOf('writesFromHere(c)')).toBeLessThan(body.indexOf(firstWrite));
  };
  it('each create takes the mark back before its first write', () => {
    marksBefore('mfg-sales-orders.ts', "mfgSalesOrders.post('/:docNo/payments', noWriteUntilMarked, postSoPaymentHandler)", 'postSoPaymentHandler', 'await recordSoPaymentRow(');
    marksBefore('sales-invoices.ts', "salesInvoices.post('/:id/payments', noWriteUntilMarked, postSalesInvoicePaymentHandler)", 'postSalesInvoicePaymentHandler', 'await insertSiPaymentRow(');
    marksBefore('receipts.ts', "receipts.post('/', noWriteUntilMarked, createReceiptHandler)", 'createReceiptHandler', 'await mintMonthlyDocNo(');
    marksBefore('other-debtors.ts', "otherDebtors.post('/:id/receipts', noWriteUntilMarked, createDebtorReceiptHandler)", 'createDebtorReceiptHandler', 'await mintMonthlyDocNo(');
  });
});
