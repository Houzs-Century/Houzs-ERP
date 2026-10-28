/* A customer refund on an order that carries deposit invoices (owner
   2026-09-13: partial refund 可以做; 就 DI 也需要开 CN; docs/bugs/0860). Pinned:
     • when the refund voucher POSTS, one credit note per deposit invoice it
       draws on — oldest first, full on the first, PART on the next — Dr 509
       / Cr AR (the customer), dated the voucher, carrying the voucher's id;
       the invoice refunded in full is closed by its note, the part-refunded
       one stands for the remainder;
     • the final invoice then closes the remainder, and only the remainder;
     • cancelling the voucher contras the notes and the invoices stand again;
     • a second run raises nothing beside the notes already raised;
     • money no deposit invoice covers raises no note;
     • the refund form counts what stands; the deposit-invoice page names the
       notes and the voucher.
   Same fake-PostgREST harness as tests/depositInvoiceCloseout.test.ts, with
   the voucher tables of tests/pvCustomerRefund.test.ts. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { depositInvoices } from '../src/scm/routes/deposit-invoices';
import { postPaymentVoucherHandler, cancelPaymentVoucherHandler } from '../src/scm/routes/payment-vouchers';
import { refundSourceHandler } from '../src/scm/lib/pv-refund';
import { bookSoPaymentBestEffort } from '../src/scm/lib/so-payment-row';
import { postSiRevenue } from '../src/scm/lib/post-si-revenue';
import { refundDepositInvoices } from '../src/acc/deposit-refunds';

const CO = 2;
const SO = '2990-SO-2609-001';
const SI = '2990-SI-2609-001';
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, acc_money: false, ...over,
});
const CHART: Row[] = [
  acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
  acct('320-0000', 'CASH IN HAND', 'ASSET', { acc_money: true }),
  acct('500-0003', 'SALES OF SOFA', 'INCOME'),
  acct('509-0000', 'DEPOSIT PAY BY CUSTOMER', 'INCOME'),
  acct('510-0000', 'RETURN INWARDS', 'INCOME'),
];
const ON = { company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-09-01' };

/* The refund voucher, approved and waiting to post: RM 1,200.00 back to the
   customer out of the drawer, on an order that took RM 1,000.00 + RM 500.00. */
const REFUND_PV: Row = {
  id: 'pv1', pv_number: '2990-CRF-2609-001', voucher_date: '2026-09-08', payee_name: 'Larding Chen', supplier_id: null,
  credit_account_code: '320-0000', currency: 'MYR', exchange_rate: 1, purpose: 'CUSTOMER_REFUND', notes: null, total_sen: 120_000,
  status: 'DRAFT', posted_at: null, created_at: '2026-09-08', created_by: 'u-1', updated_at: '2026-09-08', company_id: CO,
  submitted_at: '2026-09-08T01:00:00Z', submitted_by: 'Clerk', checked_at: '2026-09-08T02:00:00Z', checked_by: 'Checker',
  approved_at: '2026-09-08T03:00:00Z', approved_by: 'Chew',
  refund_source_type: 'SO', refund_source_doc_no: SO, customer_id: 'cust-larding', debtor_code: null,
};
const REFUND_LINE: Row = { id: 'l1', pv_id: 'pv1', line_no: 1, description: `Refund on ${SO}`, debit_account_code: '300-0000', amount_sen: 120_000 };

function harness() {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990', name: '2990' }],
    acc_account_roles: [],
    acc_company_settings: [{ ...ON }],
    acc_item_group_accounts: [{ company_id: CO, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' }],
    mfg_sales_orders: [{ doc_no: SO, company_id: CO, status: 'DELIVERED', debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-larding', phone: '0123' }],
    mfg_sales_order_payments: [],
    sales_invoices: [], sales_invoice_items: [], sales_invoice_payments: [],
    acc_deposit_invoices: [], acc_credit_notes: [], acc_credit_note_lines: [],
    journal_entries: [], journal_entry_lines: [],
    payment_vouchers: [{ ...REFUND_PV }], payment_voucher_lines: [{ ...REFUND_LINE }], pv_allocations: [],
    acc_bank_letters: [], acc_numbering: [], acc_supplier_advances: [], acc_vendor_memory: [],
    customer_credits: [], entity_audit_log: [], suppliers: [], mfg_so_audit_log: [],
  }, {}, [{ table: 'payment_vouchers', column: 'pv_number', name: 'payment_vouchers_pv_number_key' }], ['journal_entry_lines']);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: PV_KEYS } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.route('/deposit-invoices', depositInvoices);
  app.get('/payment-vouchers/refund-source', refundSourceHandler as never);
  app.post('/payment-vouchers/:id/post', postPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/cancel', cancelPaymentVoucherHandler as never);
  return { app, sb };
}
const payment = (id: string, amountSen: number, paidAt: string): Row => ({
  id, so_doc_no: SO, paid_at: paidAt, method: 'cash', merchant_provider: null, amount_sen: amountSen, created_by: 'u-1', company_id: CO,
});
const dis = (sb: ReturnType<typeof harness>['sb']) => sb.tables.acc_deposit_invoices as Row[];
const notes = (sb: ReturnType<typeof harness>['sb']) => sb.tables.acc_credit_notes as Row[];
const jes = (sb: ReturnType<typeof harness>['sb']) => sb.tables.journal_entries as Row[];
const linesOf = (sb: ReturnType<typeof harness>['sb'], jeNo: string) => {
  const je = jes(sb).find((j) => j.je_no === jeNo)!;
  return (sb.tables.journal_entry_lines as Row[]).filter((l) => l.journal_entry_id === je.id)
    .map((l) => ({ code: l.account_code, dr: Number(l.debit_sen), cr: Number(l.credit_sen), party: l.party_code ?? null }));
};
const netOf = (sb: ReturnType<typeof harness>['sb'], code: string) =>
  (sb.tables.journal_entry_lines as Row[]).filter((l) => l.account_code === code).reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0);

/** Two deposits on the order, each with its deposit invoice. */
async function withTwoDeposits(sb: ReturnType<typeof harness>['sb']) {
  await bookSoPaymentBestEffort(sb, payment('p-1', 100_000, '2026-09-02'), 'payment');
  await bookSoPaymentBestEffort(sb, payment('p-2', 50_000, '2026-09-05'), 'payment');
  expect(dis(sb).map((d) => d.di_number)).toEqual(['2990-DI-2609-001', '2990-DI-2609-002']);
}
const withFinalInvoice = (sb: ReturnType<typeof harness>['sb']) => {
  (sb.tables.sales_invoices as Row[]).push({
    id: 'si-1', company_id: CO, invoice_number: SI, so_doc_no: SO, status: 'SENT', invoice_date: '2026-09-10',
    debtor_code: null, debtor_name: 'Larding Chen', total_sen: 300_000, paid_sen: 0, migrated_no_stock: false,
  });
  (sb.tables.sales_invoice_items as Row[]).push({ id: 'sii-1', company_id: CO, sales_invoice_id: 'si-1', item_group: 'sofa', line_total_sen: 300_000 });
};
const postRefund = (app: Hono) => app.request('/payment-vouchers/pv1/post', { method: 'POST' });

describe('a refund voucher on an order with deposit invoices', () => {
  test('posting it raises a credit note per invoice it draws on — full on the first, part on the second — Dr 509 / Cr AR, dated the voucher, carrying the voucher', async () => {
    const { app, sb } = harness();
    await withTwoDeposits(sb);
    const res = await postRefund(app);
    expect(res.status).toBe(200);
    expect(sb.tables.payment_vouchers[0]!.status).toBe('POSTED');

    expect(notes(sb).map((n) => [n.note_number, n.kind, n.status, n.sales_invoice_id, n.source_doc_no, n.note_date, n.total_sen, n.refund_pv_id, n.party_code])).toEqual([
      ['2990-CN-2609-001', 'CN', 'POSTED', null, '2990-DI-2609-001', '2026-09-08', 100_000, 'pv1', 'cust-larding'],
      ['2990-CN-2609-002', 'CN', 'POSTED', null, '2990-DI-2609-002', '2026-09-08', 20_000, 'pv1', 'cust-larding'],
    ]);
    expect((sb.tables.acc_credit_note_lines as Row[]).map((l) => [l.account_code, l.amount_sen])).toEqual([['509-0000', 100_000], ['509-0000', 20_000]]);
    /* Refunded in full → closed by its note; in part → still standing. */
    expect(dis(sb).map((d) => d.credit_note_id ?? null)).toEqual([notes(sb)[0]!.id, null]);
    expect(jes(sb).map((j) => j.source_type)).toEqual(['SOPAY', 'DI', 'SOPAY', 'DI', 'PV', 'CN', 'CN']);
    const cn1 = jes(sb).find((j) => j.source_doc_no === '2990-CN-2609-001')!;
    expect(cn1.entry_date).toBe('2026-09-08');
    expect(linesOf(sb, String(cn1.je_no))).toEqual([
      { code: '509-0000', dr: 100_000, cr: 0, party: null },
      { code: '300-0000', dr: 0, cr: 100_000, party: 'cust-larding' },
    ]);
    /* The customer: paid 1,500, got 1,200 back → AR nets to nothing (the
       deposit invoices and their notes cancel), and 509 holds the 300 still
       earned as deposit. */
    expect(netOf(sb, '300-0000')).toBe(0);
    expect(-netOf(sb, '509-0000')).toBe(30_000);
  });

  test('the final invoice then closes the second invoice for the remainder, and passes over the first', async () => {
    const { app, sb } = harness();
    await withTwoDeposits(sb);
    await postRefund(app);
    withFinalInvoice(sb);
    expect(await postSiRevenue(sb, SI)).toMatchObject({ ok: true, status: 'posted', totalSen: 300_000 });
    expect(notes(sb).map((n) => [n.note_number, n.sales_invoice_id, n.source_doc_no, n.total_sen, n.refund_pv_id])).toEqual([
      ['2990-CN-2609-001', null, '2990-DI-2609-001', 100_000, 'pv1'],
      ['2990-CN-2609-002', null, '2990-DI-2609-002', 20_000, 'pv1'],
      ['2990-CN-2609-003', 'si-1', '2990-DI-2609-002', 30_000, null],
    ]);
    expect(dis(sb).map((d) => d.credit_note_id)).toEqual([notes(sb)[0]!.id, notes(sb)[2]!.id]);
    /* Paid 1,500, refunded 1,200, invoiced 3,000 → owes 2,700; 509 nets to nothing. */
    expect(netOf(sb, '300-0000')).toBe(270_000);
    expect(netOf(sb, '509-0000')).toBe(0);
  });

  test('cancelling the voucher contras its notes and the invoices stand again; a second run raises nothing beside its own', async () => {
    const { app, sb } = harness();
    await withTwoDeposits(sb);
    await postRefund(app);
    /* Idempotent: the same voucher again finds its two notes. */
    const again = await refundDepositInvoices(sb, { companyId: CO, pvId: 'pv1', pvNumber: '2990-CRF-2609-001', voucherDate: '2026-09-08', soDocNo: SO, amountSen: 120_000, actor: 'Chew' });
    expect(again).toMatchObject({ ok: true, uncoveredSen: 0 });
    expect((again as { raised: Array<{ noteNumber: string }> }).raised.map((r) => r.noteNumber)).toEqual(['2990-CN-2609-001', '2990-CN-2609-002']);
    expect(notes(sb)).toHaveLength(2);

    expect((await app.request('/payment-vouchers/pv1/cancel', { method: 'POST' })).status).toBe(200);
    expect(sb.tables.payment_vouchers[0]!.status).toBe('CANCELLED');
    expect(notes(sb).map((n) => [n.note_number, n.status])).toEqual([['2990-CN-2609-001', 'CANCELLED'], ['2990-CN-2609-002', 'CANCELLED']]);
    expect(dis(sb).map((d) => [d.status, d.credit_note_id ?? null])).toEqual([["ISSUED", null], ["ISSUED", null]]);
    expect(jes(sb).filter((j) => j.source_type === 'CN_REVERSAL')).toHaveLength(2);
    expect(jes(sb).filter((j) => j.source_type === 'PV_REVERSAL')).toHaveLength(1);
    /* Everything is back where it was: AR the two deposits, 509 the two deposits earned. */
    expect(netOf(sb, '300-0000')).toBe(0);
    expect(-netOf(sb, '509-0000')).toBe(150_000);
  });

  /* The order's own books (owner 2026-09-16): the refund leaves the order as a
     negative payment row that follows the voucher, so its Paid and Balance
     move; it books nothing (the voucher did) and goes when the voucher is
     cancelled. */
  test('posting it mirrors the refund on the order as a negative row following the voucher; cancelling takes the row with it', async () => {
    const { app, sb } = harness();
    await withTwoDeposits(sb);
    await postRefund(app);
    const rows = () => sb.tables.mfg_sales_order_payments as Row[];
    const mirror = rows().find((r) => r.refund_pv_id === 'pv1')!;
    expect(mirror).toMatchObject({ so_doc_no: SO, method: 'converted', amount_sen: -120_000, paid_at: '2026-09-08', account_sheet: 'Refund 2990-CRF-2609-001', note: 'Refunded by 2990-CRF-2609-001', created_by: null });
    /* The two deposits above were handed to the hook, never inserted: the mirror is the only row here. */
    expect(rows().map((r) => r.amount_sen)).toEqual([-120_000]);
    expect(jes(sb).some((j) => j.source_doc_no === mirror.id)).toBe(false);
    expect((sb.tables.mfg_so_audit_log as Row[]).map((a) => [a.so_doc_no, a.action, a.source, a.payment_id])).toEqual([[SO, 'ADD_PAYMENT', 'automation', mirror.id]]);
    /* Posting again finds it (the voucher is already posted, but the hook is idempotent on its own). */
    const { mirrorRefundBestEffort } = await import('../src/scm/lib/so-payment-row');
    await mirrorRefundBestEffort(sb, { companyId: CO, pvId: 'pv1', pvNumber: '2990-CRF-2609-001', voucherDate: '2026-09-08', soDocNo: SO, amountSen: 120_000, actor: 'Chew' });
    expect(rows().filter((r) => r.refund_pv_id === 'pv1')).toHaveLength(1);

    expect((await app.request('/payment-vouchers/pv1/cancel', { method: 'POST' })).status).toBe(200);
    expect(rows()).toEqual([]);
    expect((sb.tables.mfg_so_audit_log as Row[]).map((a) => [a.action, a.note])).toEqual([['ADD_PAYMENT', 'Refund voucher 2990-CRF-2609-001 posted'], ['DELETE_PAYMENT', 'refund voucher 2990-CRF-2609-001 cancelled']]);
  });

  test('money no deposit invoice covers raises no note, and is reported', async () => {
    const { sb } = harness();
    await bookSoPaymentBestEffort(sb, payment('p-1', 100_000, '2026-09-02'), 'payment');
    const r = await refundDepositInvoices(sb, { companyId: CO, pvId: 'pv1', pvNumber: '2990-CRF-2609-001', voucherDate: '2026-09-08', soDocNo: SO, amountSen: 120_000, actor: 'Chew' });
    expect(r).toMatchObject({ ok: true, uncoveredSen: 20_000 });
    expect((r as { raised: Array<{ diNumber: string; sen: number; closed: boolean }> }).raised).toEqual([
      { diNumber: '2990-DI-2609-001', noteNumber: '2990-CN-2609-001', sen: 100_000, jeNo: expect.any(String), closed: true },
    ]);
    expect(notes(sb)).toHaveLength(1);
  });

  test('the refund form counts the invoices standing and what is left on them', async () => {
    const { app, sb } = harness();
    await withTwoDeposits(sb);
    const before = (await (await app.request(`/payment-vouchers/refund-source?type=SO&docNo=${SO}`)).json()) as { source: { deposits: unknown; refundableSen: number } };
    expect(before.source.deposits).toEqual({ count: 2, standingSen: 150_000 });
    await postRefund(app);
    const after = (await (await app.request(`/payment-vouchers/refund-source?type=SO&docNo=${SO}`)).json()) as { source: { deposits: unknown } };
    expect(after.source.deposits).toEqual({ count: 1, standingSen: 30_000 });
  });

  test('the deposit-invoice list and detail say what each was refunded, note by note, with the voucher', async () => {
    const { app, sb } = harness();
    await withTwoDeposits(sb);
    await postRefund(app);
    const list = (await (await app.request('/deposit-invoices')).json()) as { rows: Array<Record<string, unknown>> };
    const first = list.rows.find((r) => r.di_number === '2990-DI-2609-001')!;
    const second = list.rows.find((r) => r.di_number === '2990-DI-2609-002')!;
    expect(first).toMatchObject({ refunded_sen: 100_000, credit_note_number: '2990-CN-2609-001' });
    expect(first.refund_notes).toEqual([{ note_number: '2990-CN-2609-001', total_sen: 100_000, status: 'POSTED', note_date: '2026-09-08', pv_number: '2990-CRF-2609-001', converted_payment_id: null }]);
    expect(second).toMatchObject({ refunded_sen: 20_000, credit_note_number: null });
    const detail = (await (await app.request(`/deposit-invoices/${String(second.id)}`)).json()) as { invoice: Record<string, unknown> };
    expect(detail.invoice.refund_notes).toEqual([{ note_number: '2990-CN-2609-002', total_sen: 20_000, status: 'POSTED', note_date: '2026-09-08', pv_number: '2990-CRF-2609-001', converted_payment_id: null }]);
  });
});
