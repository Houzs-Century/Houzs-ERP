/* The slip-date window on a Sales Order payment (owner 2026-09-23: "when key in
   payment - transaction slip date cannot [be] more than 2 week[s]").

   Pinned here because the rule has to hold on the ENDPOINT, not only in the
   field: mobile, the API and any later client post straight to this route, and
   a date field is a suggestion until the server refuses.

     - 14 days back is in, 15 is out, tomorrow is out
     - a caller holding `scm.payment.backdate` may go outside it, and the audit
       row then says the right was used
     - a CONVERTED row is exempt: it carries the source order's payment day,
       which is money that moved, not a slip anybody keyed
     - re-dating an existing payment goes through the same window (otherwise
       "save today, edit the date after" is the way around it), while an
       amount-only edit of an already-old row still saves

   Real handlers, fake PostgREST (fakeSb) — the soMoneyConvert.test.ts harness. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { postSoPaymentHandler } from '../src/scm/routes/mfg-sales-orders';
import { todayMyt } from '../src/scm/lib/my-time';
import { shiftIsoDay } from '../src/scm/shared/payment-slip-date';
import { soRouterSource } from './lib/so-router-source';

const CO = 2;
const SO = '2990-SO-2609-070';
const CANCELLED = '2990-SO-2607-011';
const TODAY = todayMyt();
const IN_WINDOW = shiftIsoDay(TODAY, -14);
const TOO_OLD = shiftIsoDay(TODAY, -15);
const TOMORROW = shiftIsoDay(TODAY, 1);

const CHART: Row[] = [
  { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '509-0000', account_name: 'DEPOSIT PAY BY CUSTOMER', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
];

const order = (doc_no: string, status: string, over: Row = {}): Row => ({
  doc_no, company_id: CO, status, debtor_name: 'Ah Meng', debtor_code: null, phone: '0123', customer_id: 'cust-1',
  salesperson_id: 'staff-1', access_staff_ids: null, open_to_all: true, local_total_sen: 500_000,
  updated_at: '2026-08-01T02:00:00Z', ...over,
});

/** `permissions` is the caller's grant set — '*' is the Owner, [] a plain
    salesperson, and the backdate key on its own is the exception this pins. */
function harness(permissions: string[]) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    acc_account_roles: [],
    acc_bank_letters: [],
    acc_numbering: [],
    acc_company_settings: [],
    acc_deposit_invoices: [],
    acc_official_receipts: [],
    acc_credit_notes: [],
    acc_credit_note_lines: [],
    companies: [{ id: CO, code: '2990' }],
    customer_credits: [],
    entity_audit_log: [],
    /* The cancelled order's payment is BOOKED — the convert guard moves only
       money the ledger has seen. */
    journal_entries: [{
      id: 'je1', je_no: '2990-JE-2607-0001', company_id: CO, source_type: 'SOPAY', source_doc_no: 'old-1',
      reversed: false, reversed_by_je: null, entry_date: '2026-07-01', posted: true,
      narration: 'Payment on old-1', total_debit_sen: 50_000, total_credit_sen: 50_000,
    }],
    journal_entry_lines: [],
    mfg_sales_orders: [
      order(SO, 'CONFIRMED'),
      order(CANCELLED, 'CANCELLED', { local_total_sen: 100_000 }),
    ],
    mfg_sales_order_payments: [
      {
        id: 'old-1', so_doc_no: CANCELLED, paid_at: '2026-07-01', method: 'cash', merchant_provider: null,
        installment_months: null, online_type: null, approval_code: null, amount_sen: 50_000, account_sheet: null,
        slip_key: null, collected_by: 'staff-1', note: null, company_id: CO, version: 1,
        created_at: '2026-07-01T03:00:00Z', created_by: 'u1', is_deposit: false, converted_from_so_doc_no: null,
      },
    ],
    mfg_so_audit_log: [],
    sales_invoices: [],
    sales_invoice_payments: [],
    staff: [],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Sales A' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Sales A', permissions_set: new Set(permissions) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    c.set('env' as never, {} as never);
    await next();
  });
  app.post('/mfg-sales-orders/:docNo/payments', postSoPaymentHandler as never);
  return { app, sb };
}

const record = (app: Hono, paidAt: string, over: Record<string, unknown> = {}) =>
  app.request(`/mfg-sales-orders/${SO}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paidAt, method: 'cash', amountSen: 10_000, ...over }),
  });

describe('recording a payment', () => {
  test('today and the 14th day back are recorded', async () => {
    const { app } = harness([]);
    expect((await record(app, TODAY)).status).toBe(201);
    expect((await record(app, IN_WINDOW)).status).toBe(201);
  });

  test('the 15th day back is refused, and the refusal names the earliest date', async () => {
    const { app, sb } = harness([]);
    const res = await record(app, TOO_OLD);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; reason: string };
    expect(body.error).toBe('slip_date_out_of_window');
    expect(body.reason).toContain('14 days');
    // Nothing was written on the way to the refusal.
    expect(sb.tables.mfg_sales_order_payments.filter((p) => p.so_doc_no === SO)).toHaveLength(0);
  });

  test('a future date is refused too', async () => {
    const { app } = harness([]);
    const res = await record(app, TOMORROW);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('slip_date_out_of_window');
  });

  test('the backdate right records it, and the audit row says the right was used', async () => {
    const { app, sb } = harness(['scm.payment.backdate']);
    expect((await record(app, TOO_OLD)).status).toBe(201);
    const row = sb.tables.mfg_sales_order_payments.find((p) => p.so_doc_no === SO)!;
    expect(row.paid_at).toBe(TOO_OLD);
    const audit = sb.tables.mfg_so_audit_log.filter((a) => a.action === 'ADD_PAYMENT');
    expect(audit).toHaveLength(1);
    expect(String(audit[0]!.note)).toContain('14-day window');
  });

  test('money MOVED from a cancelled order keeps that order\'s day, however old', async () => {
    const { app } = harness([]);
    const res = await app.request(`/mfg-sales-orders/${SO}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paidAt: TODAY, method: 'converted', convertedFromDocNo: CANCELLED, amountSen: 10_000 }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(((await res.json()) as { payment: Row }).payment.paid_at).toBe('2026-07-01');
  });
});

/* The two write paths in this router that are NOT reachable through an exported
   handler: the payment PATCH (registered inline) and the SO-create core. Source
   assertions, the idiom so-processing-date-names.test.ts uses for exactly this —
   what must not drift is that each path asks the shared rule at all.
   Each case proves the file is still doing its job before asserting on it. */
describe('the other two write paths ask the same rule', () => {
  const src = soRouterSource();

  test('re-dating a payment is judged, and only when the date actually changes', () => {
    expect(src).toContain("mfgSalesOrders.patch('/:docNo/payments/:id'");
    expect(src).toMatch(/if \(nextPaidAt !== before\.paid_at\) \{[\s\S]{0,400}checkPaymentSlipDate\(nextPaidAt, todayMyt\(\)\)/);
    expect(src).toMatch(/checkPaymentSlipDate\(nextPaidAt[\s\S]{0,300}hasHouzsPerm\(c, SO_PAYMENT_BACKDATE\)/);
  });

  test('the SO-create payment date is judged before any row is written', () => {
    expect(src).toContain('const booksMoneyOnCreate');
    expect(src).toMatch(/booksMoneyOnCreate[\s\S]{0,400}checkPaymentSlipDate\(dateOrNull\(body\.paymentDate\)/);
    expect(src).toMatch(/booksMoneyOnCreate[\s\S]{0,600}slip_date_out_of_window/);
  });
});
