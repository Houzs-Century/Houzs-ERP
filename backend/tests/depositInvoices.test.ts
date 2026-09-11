/* Deposit invoices (owner 2026-09-12; docs/bugs/0828). Pinned:
     • the switch OFF: a booked payment gets no deposit invoice;
     • the switch ON from a day: a payment on or after it gets
       {co}-DI-YYMM-NNN, ISSUED, posted Dr AR (party the customer) / Cr
       DEPOSIT PAY BY CUSTOMER dated the payment's day; the next payment takes
       the next number; a payment before the start, or on an order that
       already carries a live sales invoice, gets none;
     • issuing twice for one payment finds the standing invoice;
     • an edit that moves the amount cancels by contra and issues the next
       number; one that moves nothing is left alone; a delete cancels;
     • the routes: the list and its status filter, the switch (a start day is
       required to switch on), the backlog count and button, cancel with a
       reason, post again, and the permission gate.
   Same fake-PostgREST harness as tests/creditNotes.test.ts. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { depositInvoices } from '../src/scm/routes/deposit-invoices';
import { bookSoPaymentBestEffort } from '../src/scm/lib/so-payment-row';
import {
  cancelDepositInvoiceForPaymentBestEffort, issueDepositInvoice, reissueDepositInvoiceBestEffort,
} from '../src/acc/deposit-invoices';

const CO = 2;
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];

const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
  acct('310-0010', 'CASH AT BANK - MAYBANK', 'ASSET'),
  acct('320-0000', 'CASH IN HAND', 'ASSET'),
  acct('326-0000', 'CARD MACHINE CLEARING (EDC)', 'ASSET'),
  acct('509-0000', 'DEPOSIT PAY BY CUSTOMER', 'INCOME'),
];
const ORDERS: Row[] = [
  { doc_no: '2990-SO-2609-001', company_id: CO, debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-larding', status: 'CONFIRMED' },
  { doc_no: '2990-SO-2607-019', company_id: CO, debtor_code: null, debtor_name: 'Mei Ling', customer_id: 'cust-mei', status: 'DELIVERED' },
];
const INVOICES: Row[] = [
  { id: 'si-1', company_id: CO, invoice_number: '2990-SI-2609-001', so_doc_no: '2990-SO-2607-019', status: 'SENT', total_sen: 500_000, paid_sen: 0 },
];
const ON = { company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-09-01' };

function harness(opts: { settings?: Row[]; perms?: readonly string[]; payments?: Row[] } = {}) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990', name: '2990' }],
    mfg_sales_orders: ORDERS.map((r) => ({ ...r })),
    mfg_sales_order_payments: (opts.payments ?? []).map((r) => ({ ...r })),
    sales_invoices: INVOICES.map((r) => ({ ...r })),
    acc_account_roles: [],
    acc_company_settings: (opts.settings ?? []).map((r) => ({ ...r })),
    acc_deposit_invoices: [],
    journal_entries: [], journal_entry_lines: [],
  }, {}, [], ['journal_entry_lines']);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: opts.perms ?? PV_KEYS } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.route('/deposit-invoices', depositInvoices);
  return { app, sb };
}
const json = (app: Hono, path: string, method: string, body?: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** A payment row the way the panel inserts it (PAYMENT_COLS, no company). */
const payment = (id: string, over: Row = {}): Row => ({
  id, so_doc_no: '2990-SO-2609-001', paid_at: '2026-09-05', method: 'cash', merchant_provider: null, amount_sen: 100_000, created_by: 'u-1', company_id: CO, ...over,
});

const linesOf = (sb: ReturnType<typeof harness>['sb'], jeNo: string) => {
  const je = (sb.tables.journal_entries as Row[]).find((j) => j.je_no === jeNo)!;
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === je.id)
    .map((l) => ({ code: l.account_code, dr: Number(l.debit_sen), cr: Number(l.credit_sen), party: l.party_code ?? null }));
};
const dis = (sb: ReturnType<typeof harness>['sb']) => sb.tables.acc_deposit_invoices as Row[];
const jes = (sb: ReturnType<typeof harness>['sb']) => sb.tables.journal_entries as Row[];

describe('the birth of a deposit invoice', () => {
  test('the switch off: a booked payment gets no deposit invoice', async () => {
    const { sb } = harness();
    await bookSoPaymentBestEffort(sb, payment('p-1'), 'payment');
    expect(jes(sb).map((j) => j.source_type)).toEqual(['SOPAY']);
    expect(dis(sb)).toHaveLength(0);
  });

  test('the switch on from 2026-09-01: a payment on 09-05 is invoiced {co}-DI-2609-001 and posted Dr AR (the customer) / Cr 509-0000 on its day; the next takes 002', async () => {
    const { sb } = harness({ settings: [ON] });
    await bookSoPaymentBestEffort(sb, payment('p-1'), 'payment');
    expect(dis(sb)).toHaveLength(1);
    const di = dis(sb)[0]!;
    expect(di).toMatchObject({
      di_number: '2990-DI-2609-001', status: 'ISSUED', payment_source: 'SOPAY', payment_id: 'p-1', so_doc_no: '2990-SO-2609-001',
      party_code: 'cust-larding', party_name: 'Larding Chen', invoice_date: '2026-09-05', amount_sen: 100_000, method: 'cash', company_id: CO,
    });
    expect(typeof di.je_no).toBe('string');
    const je = jes(sb).find((j) => j.source_type === 'DI')!;
    expect(je).toMatchObject({ source_doc_no: '2990-DI-2609-001', entry_date: '2026-09-05', je_no: di.je_no });
    expect(linesOf(sb, String(di.je_no))).toEqual([
      { code: '300-0000', dr: 100_000, cr: 0, party: 'cust-larding' },
      { code: '509-0000', dr: 0, cr: 100_000, party: null },
    ]);
    await bookSoPaymentBestEffort(sb, payment('p-2', { amount_sen: 50_000, paid_at: '2026-09-06' }), 'payment');
    expect(dis(sb).map((d) => d.di_number)).toEqual(['2990-DI-2609-001', '2990-DI-2609-002']);
  });

  test('a payment before the start day, and one on an order that already carries a live invoice, get none — each for its own reason', async () => {
    const { sb } = harness({ settings: [ON] });
    const early = await issueDepositInvoice(sb, { paymentId: 'p-old', soDocNo: '2990-SO-2609-001', paidAt: '2026-08-30', amountSen: 100_000 });
    expect(early).toEqual({ ok: true, status: 'not_due', why: 'before_start' });
    const invoiced = await issueDepositInvoice(sb, { paymentId: 'p-bal', soDocNo: '2990-SO-2607-019', paidAt: '2026-09-05', amountSen: 400_000 });
    expect(invoiced).toEqual({ ok: true, status: 'not_due', why: 'invoice_exists' });
    /* A cancelled invoice is no invoice: the order is back to deposits. */
    (sb.tables.sales_invoices as Row[])[0]!.status = 'CANCELLED';
    const again = await issueDepositInvoice(sb, { paymentId: 'p-bal', soDocNo: '2990-SO-2607-019', paidAt: '2026-09-05', amountSen: 400_000 });
    expect(again).toMatchObject({ ok: true, status: 'issued', diNumber: '2990-DI-2609-001' });
    expect(dis(sb)).toHaveLength(1);
  });

  test('issuing twice for one payment finds the standing invoice: one row, one journal', async () => {
    const { sb } = harness({ settings: [ON] });
    const first = await issueDepositInvoice(sb, { paymentId: 'p-1', soDocNo: '2990-SO-2609-001', paidAt: '2026-09-05', amountSen: 100_000 });
    const second = await issueDepositInvoice(sb, { paymentId: 'p-1', soDocNo: '2990-SO-2609-001', paidAt: '2026-09-05', amountSen: 100_000 });
    expect(first).toMatchObject({ ok: true, status: 'issued', diNumber: '2990-DI-2609-001' });
    expect(second).toMatchObject({ ok: true, status: 'already_issued', diNumber: '2990-DI-2609-001' });
    expect(dis(sb)).toHaveLength(1);
    expect(jes(sb).filter((j) => j.source_type === 'DI')).toHaveLength(1);
  });
});

describe('the invoice follows the payment', () => {
  test('an edit that moves the amount cancels the invoice by contra and issues the next number; one that moves nothing is left alone', async () => {
    const { sb } = harness({ settings: [ON] });
    await bookSoPaymentBestEffort(sb, payment('p-1'), 'payment');
    await reissueDepositInvoiceBestEffort(sb, { paymentId: 'p-1', docNo: '2990-SO-2609-001', paidAt: '2026-09-05', amountSen: 100_000, method: 'cash' });
    expect(dis(sb)).toHaveLength(1);
    await reissueDepositInvoiceBestEffort(sb, { paymentId: 'p-1', docNo: '2990-SO-2609-001', paidAt: '2026-09-05', amountSen: 80_000, method: 'cash' });
    expect(dis(sb).map((d) => [d.di_number, d.status, d.amount_sen])).toEqual([
      ['2990-DI-2609-001', 'CANCELLED', 100_000],
      ['2990-DI-2609-002', 'ISSUED', 80_000],
    ]);
    expect(dis(sb)[0]).toMatchObject({ cancel_reason: 'payment on 2990-SO-2609-001 edited — re-issued' });
    expect(jes(sb).map((j) => j.source_type)).toEqual(['SOPAY', 'DI', 'DI_REVERSAL', 'DI']);
    const contra = jes(sb).find((j) => j.source_type === 'DI_REVERSAL')!;
    expect(linesOf(sb, String(contra.je_no))).toEqual([
      { code: '300-0000', dr: 0, cr: 100_000, party: 'cust-larding' },
      { code: '509-0000', dr: 100_000, cr: 0, party: null },
    ]);
  });

  test('a deleted payment cancels its invoice by contra, kept on file with the reason', async () => {
    const { sb } = harness({ settings: [ON] });
    await bookSoPaymentBestEffort(sb, payment('p-1'), 'payment');
    await cancelDepositInvoiceForPaymentBestEffort(sb, { paymentId: 'p-1', reason: 'payment on 2990-SO-2609-001 deleted' });
    expect(dis(sb)).toEqual([expect.objectContaining({ di_number: '2990-DI-2609-001', status: 'CANCELLED', cancel_reason: 'payment on 2990-SO-2609-001 deleted' })]);
    expect(jes(sb).map((j) => j.source_type)).toEqual(['SOPAY', 'DI', 'DI_REVERSAL']);
    /* Nothing standing: a second delete has nothing to cancel and says nothing. */
    await cancelDepositInvoiceForPaymentBestEffort(sb, { paymentId: 'p-1', reason: 'again' });
    expect(jes(sb)).toHaveLength(3);
  });
});

describe('the routes', () => {
  test('the list, filtered by status; one invoice opens with its payment', async () => {
    const { app, sb } = harness({ settings: [ON], payments: [payment('p-1'), payment('p-2', { amount_sen: 50_000 })] });
    await bookSoPaymentBestEffort(sb, payment('p-1'), 'payment');
    await bookSoPaymentBestEffort(sb, payment('p-2', { amount_sen: 50_000 }), 'payment');
    await cancelDepositInvoiceForPaymentBestEffort(sb, { paymentId: 'p-2', reason: 'test' });
    const all = await json(app, '/deposit-invoices', 'GET');
    expect(all.status).toBe(200);
    expect((await all.json() as { rows: Row[] }).rows.map((r) => r.di_number)).toEqual(['2990-DI-2609-002', '2990-DI-2609-001']);
    const issued = await json(app, '/deposit-invoices?status=ISSUED', 'GET');
    expect((await issued.json() as { rows: Row[] }).rows.map((r) => r.di_number)).toEqual(['2990-DI-2609-001']);
    const id = String(dis(sb)[0]!.id);
    const one = await json(app, `/deposit-invoices/${id}`, 'GET');
    expect(one.status).toBe(200);
    const b = await one.json() as { invoice: Row; payment: Row | null };
    expect(b.invoice).toMatchObject({ di_number: '2990-DI-2609-001' });
    expect(b.payment).toMatchObject({ id: 'p-1', method: 'cash', amount_sen: 100_000 });
  });

  test('the switch: off by default with nothing missing; switching on needs a start day; on from a past day counts the payments left behind, and the button issues them', async () => {
    const { app, sb } = harness({
      payments: [payment('p-1'), payment('p-2', { paid_at: '2026-08-20' }), payment('p-3', { so_doc_no: '2990-SO-2607-019', paid_at: '2026-09-07' })],
    });
    const off = await json(app, '/deposit-invoices/settings', 'GET');
    expect(await off.json()).toEqual({ settings: { enabled: false, fromDate: null }, missingCount: 0 });
    const noDay = await json(app, '/deposit-invoices/settings', 'POST', { enabled: true });
    expect(noDay.status).toBe(400);
    expect((await noDay.json() as { error: string }).error).toBe('from_date_required');
    const badDay = await json(app, '/deposit-invoices/settings', 'POST', { enabled: true, fromDate: '1/9/2026' });
    expect(badDay.status).toBe(400);
    expect((await badDay.json() as { error: string }).error).toBe('bad_from_date');
    const on = await json(app, '/deposit-invoices/settings', 'POST', { enabled: true, fromDate: '2026-09-01' });
    expect(on.status).toBe(200);
    /* p-1 is due; p-2 is before the start; p-3's order already has an invoice. */
    expect(await on.json()).toEqual({ ok: true, settings: { enabled: true, fromDate: '2026-09-01' }, missingCount: 1 });
    expect(sb.tables.acc_company_settings).toEqual([expect.objectContaining({ company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-09-01', updated_by: 'Chew' })]);
    const issue = await json(app, '/deposit-invoices/issue-missing', 'POST', {});
    expect(issue.status).toBe(200);
    expect(await issue.json()).toEqual({ ok: true, issued: ['2990-DI-2609-001'], skipped: [] });
    expect(dis(sb)).toEqual([expect.objectContaining({ payment_id: 'p-1', created_by: 'Chew' })]);
    const after = await json(app, '/deposit-invoices/settings', 'GET');
    expect(await after.json()).toEqual({ settings: { enabled: true, fromDate: '2026-09-01' }, missingCount: 0 });
    /* Off again keeps the day for next time. */
    const offAgain = await json(app, '/deposit-invoices/settings', 'POST', { enabled: false, fromDate: '2026-09-01' });
    expect(await offAgain.json()).toMatchObject({ settings: { enabled: false, fromDate: '2026-09-01' }, missingCount: 0 });
  });

  test('cancel needs a reason and writes the contra; post again fills a missing journal; a cancelled invoice is not posted', async () => {
    const { app, sb } = harness({ settings: [ON] });
    await bookSoPaymentBestEffort(sb, payment('p-1'), 'payment');
    const id = String(dis(sb)[0]!.id);
    const noReason = await json(app, `/deposit-invoices/${id}/cancel`, 'POST', {});
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { error: string }).error).toBe('reason_required');
    /* An invoice whose journal was refused at birth: post again fills it. */
    dis(sb)[0]!.je_no = null;
    (sb.tables.journal_entries as Row[]).splice(0);
    (sb.tables.journal_entry_lines as Row[]).splice(0);
    const posted = await json(app, `/deposit-invoices/${id}/post`, 'POST', {});
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({ ok: true, status: 'posted' });
    expect(dis(sb)[0]!.je_no).toBe(jes(sb)[0]!.je_no);
    const cancelled = await json(app, `/deposit-invoices/${id}/cancel`, 'POST', { reason: 'Customer changed order' });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ ok: true, status: 'cancelled', contraJeNo: expect.any(String) });
    expect(dis(sb)[0]).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Customer changed order', cancelled_by: 'Chew' });
    expect(jes(sb).map((j) => j.source_type)).toEqual(['DI', 'DI_REVERSAL']);
    const twice = await json(app, `/deposit-invoices/${id}/cancel`, 'POST', { reason: 'again' });
    expect(await twice.json()).toMatchObject({ ok: true, status: 'already_cancelled' });
    const postCancelled = await json(app, `/deposit-invoices/${id}/post`, 'POST', {});
    expect(postCancelled.status).toBe(409);
  });

  test('the switch, the backlog button, post and cancel answer 403 without the PV keys; reading does not', async () => {
    const { app, sb } = harness({ settings: [ON], perms: ['scm.access'] });
    await bookSoPaymentBestEffort(sb, payment('p-1'), 'payment');
    const id = String(dis(sb)[0]!.id);
    expect((await json(app, '/deposit-invoices', 'GET')).status).toBe(200);
    expect((await json(app, '/deposit-invoices/settings', 'GET')).status).toBe(200);
    expect((await json(app, '/deposit-invoices/settings', 'POST', { enabled: false })).status).toBe(403);
    expect((await json(app, '/deposit-invoices/issue-missing', 'POST', {})).status).toBe(403);
    expect((await json(app, `/deposit-invoices/${id}/post`, 'POST', {})).status).toBe(403);
    expect((await json(app, `/deposit-invoices/${id}/cancel`, 'POST', { reason: 'x' })).status).toBe(403);
  });
});
