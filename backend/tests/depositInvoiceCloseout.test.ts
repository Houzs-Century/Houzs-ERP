/* The deposit-invoice close-out (owner 2026-09-12; docs/bugs/0831). Pinned:
     • when the order's final invoice posts its revenue, every deposit invoice
       standing on the order is closed by a credit note of its own — CN,
       {co}-CN-YYMM-NNN, dated the invoice's day, Dr DEPOSIT PAY BY CUSTOMER
       / Cr AR with the customer as party, linked on credit_note_id;
     • a second posting raises nothing beside them; an order with no deposit
       invoice raises nothing;
     • a cancelled final invoice cancels the notes by contra and the deposit
       invoices stand again; a note Finance raised by hand stays;
     • the deposit-invoice list names the note that closed each.
   Same fake-PostgREST harness as tests/depositInvoices.test.ts. */

import { Hono } from 'hono';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { depositInvoices } from '../src/scm/routes/deposit-invoices';
import { bookSoPaymentBestEffort } from '../src/scm/lib/so-payment-row';
import { postSiRevenue } from '../src/scm/lib/post-si-revenue';
import { releaseDepositInvoicesFromInvoice } from '../src/acc/deposit-invoices';

const CO = 2;
const SO = '2990-SO-2609-001';
const SI = '2990-SI-2609-001';
const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
const acct = (code: string, name: string, type: string, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, is_active: true, special_type: null, ...over,
});
const CHART: Row[] = [
  acct('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', { special_type: 'SDC' }),
  acct('320-0000', 'CASH IN HAND', 'ASSET'),
  acct('500-0003', 'SALES OF SOFA', 'INCOME'),
  acct('509-0000', 'DEPOSIT PAY BY CUSTOMER', 'INCOME'),
  acct('510-0000', 'RETURN INWARDS', 'INCOME'),
];
const ON = { company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-09-01' };

function harness() {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    companies: [{ id: CO, code: '2990', name: '2990' }],
    acc_account_roles: [],
    acc_company_settings: [{ ...ON }],
    acc_item_group_accounts: [{ company_id: CO, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' }],
    mfg_sales_orders: [{ doc_no: SO, company_id: CO, status: 'DELIVERED', debtor_code: null, debtor_name: 'Larding Chen', customer_id: 'cust-larding' }],
    mfg_sales_order_payments: [],
    sales_invoices: [],
    sales_invoice_items: [],
    acc_deposit_invoices: [], acc_credit_notes: [], acc_credit_note_lines: [],
    journal_entries: [], journal_entry_lines: [],
  }, {}, [], ['journal_entry_lines']);
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

/** Two deposits on the order, each with its deposit invoice — taken BEFORE
    the final invoice exists (a deposit after it is no deposit) — then the
    final invoice, raised and not yet posted. */
async function withTwoDeposits(sb: ReturnType<typeof harness>['sb']) {
  await bookSoPaymentBestEffort(sb, payment('p-1', 100_000, '2026-09-02'), 'payment');
  await bookSoPaymentBestEffort(sb, payment('p-2', 50_000, '2026-09-05'), 'payment');
  expect(dis(sb).map((d) => d.di_number)).toEqual(['2990-DI-2609-001', '2990-DI-2609-002']);
  (sb.tables.sales_invoices as Row[]).push({
    id: 'si-1', company_id: CO, invoice_number: SI, so_doc_no: SO, status: 'SENT', invoice_date: '2026-09-10',
    debtor_code: null, debtor_name: 'Larding Chen', total_sen: 300_000, paid_sen: 0, migrated_no_stock: false,
  });
  (sb.tables.sales_invoice_items as Row[]).push({ id: 'sii-1', company_id: CO, sales_invoice_id: 'si-1', item_group: 'sofa', line_total_sen: 300_000 });
}

describe('the close-out at the final invoice', () => {
  test('posting the final invoice closes each deposit invoice with a posted credit note — Dr 509-0000 / Cr AR (the customer), dated the invoice, linked', async () => {
    const { sb } = harness();
    await withTwoDeposits(sb);
    const posted = await postSiRevenue(sb, SI);
    expect(posted).toMatchObject({ ok: true, status: 'posted', totalSen: 300_000 });
    expect(notes(sb).map((n) => [n.note_number, n.kind, n.status, n.sales_invoice_id, n.source_doc_no, n.note_date, n.total_sen, n.party_code])).toEqual([
      ['2990-CN-2609-001', 'CN', 'POSTED', 'si-1', '2990-DI-2609-001', '2026-09-10', 100_000, 'cust-larding'],
      ['2990-CN-2609-002', 'CN', 'POSTED', 'si-1', '2990-DI-2609-002', '2026-09-10', 50_000, 'cust-larding'],
    ]);
    expect((sb.tables.acc_credit_note_lines as Row[]).map((l) => [l.account_code, l.amount_sen])).toEqual([['509-0000', 100_000], ['509-0000', 50_000]]);
    expect(dis(sb).map((d) => d.credit_note_id)).toEqual([notes(sb)[0]!.id, notes(sb)[1]!.id]);
    expect(jes(sb).map((j) => j.source_type)).toEqual(['SOPAY', 'DI', 'SOPAY', 'DI', 'SI', 'CN', 'CN']);
    const cn1 = jes(sb).find((j) => j.source_doc_no === '2990-CN-2609-001')!;
    expect(cn1.entry_date).toBe('2026-09-10');
    expect(linesOf(sb, String(cn1.je_no))).toEqual([
      { code: '509-0000', dr: 100_000, cr: 0, party: null },
      { code: '300-0000', dr: 0, cr: 100_000, party: 'cust-larding' },
    ]);
    /* The customer's receivable across the four documents: deposits −150,000,
       deposit invoices +150,000, the final invoice +300,000, the notes
       −150,000 → the 150,000 still owed; 509-0000 nets to nothing. */
    const arNet = (sb.tables.journal_entry_lines as Row[]).filter((l) => l.account_code === '300-0000').reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0);
    expect(arNet).toBe(150_000);
    const depositNet = (sb.tables.journal_entry_lines as Row[]).filter((l) => l.account_code === '509-0000').reduce((s, l) => s + Number(l.credit_sen) - Number(l.debit_sen), 0);
    expect(depositNet).toBe(0);
  });

  test('a second posting raises nothing beside them; an order with no deposit invoice raises nothing', async () => {
    const { sb } = harness();
    await withTwoDeposits(sb);
    await postSiRevenue(sb, SI);
    expect(await postSiRevenue(sb, SI)).toMatchObject({ ok: true, status: 'already_posted' });
    expect(notes(sb)).toHaveLength(2);
    const bare = harness().sb;
    (bare.tables.sales_invoices as Row[]).push({ id: 'si-1', company_id: CO, invoice_number: SI, so_doc_no: SO, status: 'SENT', invoice_date: '2026-09-10', debtor_code: null, debtor_name: 'Larding Chen', total_sen: 300_000, paid_sen: 0, migrated_no_stock: false });
    (bare.tables.sales_invoice_items as Row[]).push({ id: 'sii-1', company_id: CO, sales_invoice_id: 'si-1', item_group: 'sofa', line_total_sen: 300_000 });
    expect(await postSiRevenue(bare, SI)).toMatchObject({ ok: true, status: 'posted' });
    expect(notes(bare)).toHaveLength(0);
  });

  test('a cancelled final invoice cancels the notes by contra and the deposit invoices stand again; a hand-raised note against the invoice stays', async () => {
    const { sb } = harness();
    await withTwoDeposits(sb);
    await postSiRevenue(sb, SI);
    /* Finance's own note against the invoice — no deposit invoice points at it. */
    notes(sb).push({ id: 'n-hand', company_id: CO, note_number: '2990-CN-2609-003', kind: 'CN', status: 'POSTED', sales_invoice_id: 'si-1', source_doc_no: 'DR-1', note_date: '2026-09-11', total_sen: 1_000, party_code: 'cust-larding' });
    const r = await releaseDepositInvoicesFromInvoice(sb, { companyId: CO, siId: 'si-1', actor: 'Chew' });
    expect(r).toEqual({ ok: true, released: ['2990-DI-2609-001', '2990-DI-2609-002'] });
    expect(notes(sb).map((n) => [n.note_number, n.status])).toEqual([
      ['2990-CN-2609-001', 'CANCELLED'], ['2990-CN-2609-002', 'CANCELLED'], ['2990-CN-2609-003', 'POSTED'],
    ]);
    expect(dis(sb).map((d) => [d.status, d.credit_note_id])).toEqual([['ISSUED', null], ['ISSUED', null]]);
    expect(jes(sb).filter((j) => j.source_type === 'CN_REVERSAL')).toHaveLength(2);
    expect(await releaseDepositInvoicesFromInvoice(sb, { companyId: CO, siId: 'si-1', actor: 'Chew' })).toEqual({ ok: true, released: [] });
    /* And a new final invoice closes them again, with the next numbers. */
    (sb.tables.journal_entries as Row[]).find((j) => j.source_type === 'SI')!.reversed = true;
    const again = await postSiRevenue(sb, SI);
    expect(again).toMatchObject({ ok: true, status: 'posted' });
    expect(notes(sb).filter((n) => n.status === 'POSTED').map((n) => n.note_number)).toEqual(['2990-CN-2609-003', '2990-CN-2609-004', '2990-CN-2609-005']);
    expect(dis(sb).every((d) => typeof d.credit_note_id === 'string')).toBe(true);
  });

  test('the deposit-invoice list and detail name the note that closed each', async () => {
    const { app, sb } = harness();
    await withTwoDeposits(sb);
    await postSiRevenue(sb, SI);
    const list = await app.request('/deposit-invoices');
    expect(list.status).toBe(200);
    const rows = (await list.json() as { rows: Row[] }).rows;
    expect(rows.map((r) => [r.di_number, r.credit_note_number])).toEqual([['2990-DI-2609-002', '2990-CN-2609-002'], ['2990-DI-2609-001', '2990-CN-2609-001']]);
    const one = await app.request(`/deposit-invoices/${String(dis(sb)[0]!.id)}`);
    expect((await one.json() as { invoice: Row }).invoice).toMatchObject({ di_number: '2990-DI-2609-001', credit_note_number: '2990-CN-2609-001' });
  });
});
