// The Customer Refund voucher (payment-voucher.md §14, owner 2026-09-07). Pinned:
//   • refund-source names the document's customer and payments, counts only
//     the money THIS ledger booked, and reserves every non-cancelled refund;
//   • a Sales Order refunds any time; a Sales Invoice only when CANCELLED, a
//     migrated one never — with the reason;
//   • create composes the ONE Dr AR line itself, stamps the source and the
//     customer, refuses an amount past the headroom (draft vouchers count);
//   • CHECK mints {co}{letter}RF — cash {co}CRF;
//   • POST writes Dr AR (party CUSTOMER) / Cr the money account, and the
//     customer-credit row only when the document carries a debtor code;
//   • CANCEL reverses the journal and hands the credit back.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  createPaymentVoucherHandler, checkPaymentVoucherHandler, postPaymentVoucherHandler, cancelPaymentVoucherHandler,
} from '../src/scm/routes/payment-vouchers';
import { refundSourceHandler } from '../src/scm/lib/pv-refund';

const CO = 2;
const yymm = '2607';
const SO = '2990-SO-2607-001';

const CHART: Row[] = [
  { company_id: CO, account_code: '300-0000', account_name: 'TRADE DEBTORS', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '310-0010', account_name: 'MAYBANK', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '900-0000', account_name: 'RENT', parent_code: null, is_active: true, acc_money: false },
];

/* The order: three payments — a transfer this ledger booked, an AutoCount-era
   import, and a cash row whose hook never ran. Only the first counts. */
const ORDER: Row = { doc_no: SO, company_id: CO, status: 'CANCELLED', debtor_name: 'Ah Meng', debtor_code: null, phone: '0123', customer_id: 'cust-1' };
const PAYMENTS: Row[] = [
  { id: 'p1', so_doc_no: SO, paid_at: '2026-07-01', method: 'transfer', merchant_provider: null, amount_sen: 50000, company_id: CO },
  { id: 'p2', so_doc_no: SO, paid_at: '2026-07-02', method: 'imported', merchant_provider: null, amount_sen: 30000, company_id: CO },
  { id: 'p3', so_doc_no: SO, paid_at: '2026-07-03', method: 'cash', merchant_provider: null, amount_sen: 20000, company_id: CO },
];
const BOOKED_JE: Row = { id: 'je-so', je_no: `2990-JE-${yymm}-001`, company_id: CO, source_type: 'SOPAY', source_doc_no: 'p1', reversed: false, entry_date: '2026-07-01' };

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = ['*']) {
  const sb = fakeSb(
    {
      accounts: CHART.map((r) => ({ ...r })),
      acc_account_roles: [],
      acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }],
      acc_numbering: [],
      acc_supplier_advances: [],
      acc_vendor_memory: [],
      companies: [{ id: CO, code: '2990' }],
      customer_credits: [],
      entity_audit_log: [],
      journal_entries: [{ ...BOOKED_JE }],
      journal_entry_lines: [],
      mfg_sales_orders: [{ ...ORDER }],
      mfg_sales_order_payments: PAYMENTS.map((r) => ({ ...r })),
      payment_voucher_lines: [],
      payment_vouchers: [],
      pv_allocations: [],
      sales_invoices: [],
      sales_invoice_payments: [],
      suppliers: [],
      ...tables,
    },
    {},
    [{ table: 'payment_vouchers', column: 'pv_number', name: 'payment_vouchers_pv_number_key' }],
  );
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.get('/payment-vouchers/refund-source', refundSourceHandler as never);
  app.post('/payment-vouchers', createPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/check', checkPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/post', postPaymentVoucherHandler as never);
  app.post('/payment-vouchers/:id/cancel', cancelPaymentVoucherHandler as never);
  return { app, sb };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const REFUND = {
  purpose: 'CUSTOMER_REFUND', payeeName: 'typed by hand', creditAccountCode: '310-0010', voucherDate: '2026-07-05',
  refundSourceType: 'SO', refundSourceDocNo: SO, refundAmountSen: 30000,
  /* Lines on the wire are IGNORED for a refund — the system composes the one line. */
  lines: [{ description: 'smuggled', debitAccountCode: '900-0000', amountSen: 1 }],
};

describe('refund-source — 认单为主', () => {
  test('a Sales Order: customer, every payment with its booked flag, and the headroom this ledger allows', async () => {
    const { app } = harness();
    const res = await app.request(`/payment-vouchers/refund-source?type=so&docNo=${SO}`);
    expect(res.status).toBe(200);
    const { source } = await res.json() as { source: Record<string, any> };
    expect(source).toMatchObject({
      type: 'SO', docNo: SO, status: 'CANCELLED',
      customer: { name: 'Ah Meng', phone: '0123', customerId: 'cust-1', debtorCode: null },
      bookedSen: 50000, refundedSen: 0, refundableSen: 50000, eligible: true, reason: null,
    });
    expect(source.payments.map((p: Row) => [p.id, p.booked])).toEqual([['p1', true], ['p2', false], ['p3', false]]);
  });

  test('a draft refund already on the order is spoken for', async () => {
    const { app } = harness({
      payment_vouchers: [{ id: 'pv-d', pv_number: `2990-Draft-${yymm}-001`, company_id: CO, purpose: 'CUSTOMER_REFUND', refund_source_doc_no: SO, status: 'DRAFT', voucher_date: '2026-07-05', total_sen: 20000 }],
    });
    const { source } = await (await app.request(`/payment-vouchers/refund-source?type=SO&docNo=${SO}`)).json() as { source: Record<string, any> };
    expect(source).toMatchObject({ refundedSen: 20000, refundableSen: 30000, eligible: true });
    expect(source.refunds).toEqual([{ id: 'pv-d', pvNumber: `2990-Draft-${yymm}-001`, status: 'DRAFT', voucherDate: '2026-07-05', totalSen: 20000 }]);
  });

  test('a live Sales Invoice is refused with the reason; a cancelled one refunds; a migrated one never', async () => {
    const si = (over: Row) => ({ id: 'si-1', invoice_number: 'HC-SI-2607-001', company_id: CO, status: 'SENT', debtor_name: 'Ali', debtor_code: 'D001', migrated_no_stock: false, ...over });
    const world = (over: Row) => harness({
      sales_invoices: [si(over)],
      sales_invoice_payments: [{ id: 'sp1', sales_invoice_id: 'si-1', paid_at: '2026-07-01', method: 'transfer', merchant_provider: null, amount_sen: 80000, company_id: CO }],
      journal_entries: [{ ...BOOKED_JE, id: 'je-si', source_type: 'SIPAY', source_doc_no: 'sp1' }],
    });
    const read = async (over: Row) => (await (await world(over).app.request('/payment-vouchers/refund-source?type=SI&docNo=HC-SI-2607-001')).json()) as { source: Record<string, any> };
    const live = await read({});
    expect(live.source).toMatchObject({ eligible: false, bookedSen: 80000 });
    expect(live.source.reason).toMatch(/still stands/);
    const cancelled = await read({ status: 'CANCELLED' });
    expect(cancelled.source).toMatchObject({ eligible: true, refundableSen: 80000, customer: { name: 'Ali', debtorCode: 'D001' } });
    const migrated = await read({ status: 'CANCELLED', migrated_no_stock: true });
    expect(migrated.source.eligible).toBe(false);
    expect(migrated.source.reason).toMatch(/migrated/);
  });

  test('an unknown document is a 404, another company\'s too', async () => {
    const { app } = harness({ mfg_sales_orders: [{ ...ORDER, company_id: 1 }] });
    expect((await app.request(`/payment-vouchers/refund-source?type=SO&docNo=${SO}`)).status).toBe(404);
    expect((await app.request('/payment-vouchers/refund-source?type=SO&docNo=nope')).status).toBe(404);
    expect((await app.request(`/payment-vouchers/refund-source?type=XX&docNo=${SO}`)).status).toBe(400);
  });
});

describe('create — the one line is the system\'s', () => {
  test('stamps the source and the customer, composes Dr AR for the amount, ignores the wire\'s lines', async () => {
    const { app, sb } = harness();
    const res = await app.request('/payment-vouchers', json(REFUND));
    expect(res.status).toBe(201);
    const pv = sb.tables.payment_vouchers[0]!;
    expect(pv).toMatchObject({
      purpose: 'CUSTOMER_REFUND', payee_name: 'Ah Meng', refund_source_type: 'SO', refund_source_doc_no: SO,
      customer_id: 'cust-1', debtor_code: null, total_sen: 30000, credit_account_code: '310-0010', status: 'DRAFT',
    });
    expect(String(pv.pv_number)).toBe(`2990-Draft-${yymm}-001`);
    expect(sb.tables.payment_voucher_lines).toHaveLength(1);
    expect(sb.tables.payment_voucher_lines[0]).toMatchObject({ debit_account_code: '300-0000', amount_sen: 30000, description: `Refund on ${SO}` });
  });

  test('past the headroom is refused with the three figures — a draft already on the order counts', async () => {
    const { app, sb } = harness();
    expect((await app.request('/payment-vouchers', json(REFUND))).status).toBe(201);
    const res = await app.request('/payment-vouchers', json({ ...REFUND, refundAmountSen: 30000 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'refund_exceeds_booked', bookedSen: 50000, refundedSen: 30000, refundableSen: 20000 });
    expect(sb.tables.payment_vouchers).toHaveLength(1);
  });

  test('an ineligible document, a missing amount, a non-money Paid From — each refused before anything is written', async () => {
    const { app, sb } = harness({ mfg_sales_orders: [{ ...ORDER, status: 'CONFIRMED' }], journal_entries: [] });
    const r1 = await app.request('/payment-vouchers', json(REFUND));
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as { error: string }).error).toBe('refund_not_allowed');
    expect((await app.request('/payment-vouchers', json({ ...REFUND, refundAmountSen: 0 }))).status).toBe(400);
    expect((await app.request('/payment-vouchers', json({ ...REFUND, creditAccountCode: '900-0000' }))).status).toBe(400);
    expect(sb.tables.payment_vouchers).toHaveLength(0);
  });
});

/* A refund voucher as CHECK / POST / CANCEL find it: approved through the
   four layers, on the Draft series, one system line. */
const APPROVED: Row = {
  id: 'pv1', pv_number: `2990-Draft-${yymm}-001`, voucher_date: '2026-07-05', payee_name: 'Ah Meng', supplier_id: null,
  credit_account_code: '310-0010', currency: 'MYR', exchange_rate: 1, purpose: 'CUSTOMER_REFUND', notes: null, total_sen: 30000,
  status: 'DRAFT', posted_at: null, created_at: '2026-09-07', created_by: 'u1', updated_at: '2026-09-07', company_id: CO,
  submitted_at: '2026-09-07T01:00:00Z', submitted_by: 'Clerk', checked_at: '2026-09-07T02:00:00Z', checked_by: 'Checker',
  approved_at: '2026-09-07T03:00:00Z', approved_by: 'Chew',
  refund_source_type: 'SO', refund_source_doc_no: SO, customer_id: 'cust-1', debtor_code: null,
};
const LINE: Row = { id: 'l1', pv_id: 'pv1', line_no: 1, description: `Refund on ${SO}`, debit_account_code: '300-0000', amount_sen: 30000 };

describe('CHECK mints RF', () => {
  test('from the bank letter — {co}MRF; from the drawer — {co}CRF', async () => {
    const bank = harness({ payment_vouchers: [{ ...APPROVED, checked_at: null, approved_at: null }], payment_voucher_lines: [{ ...LINE }] });
    expect((await bank.app.request('/payment-vouchers/pv1/check', { method: 'POST' })).status).toBe(200);
    expect(bank.sb.tables.payment_vouchers[0]!.pv_number).toBe(`2990-MRF-${yymm}-001`);
    const cash = harness({ payment_vouchers: [{ ...APPROVED, checked_at: null, approved_at: null, credit_account_code: '320-0000' }], payment_voucher_lines: [{ ...LINE }], acc_bank_letters: [] });
    expect((await cash.app.request('/payment-vouchers/pv1/check', { method: 'POST' })).status).toBe(200);
    expect(cash.sb.tables.payment_vouchers[0]!.pv_number).toBe(`2990-CRF-${yymm}-001`);
  });
});

describe('POST and CANCEL', () => {
  test('Dr AR (party CUSTOMER) / Cr the bank; no debtor code, no credit row', async () => {
    const { app, sb } = harness({ payment_vouchers: [{ ...APPROVED, pv_number: `2990-MRF-${yymm}-001` }], payment_voucher_lines: [{ ...LINE }] });
    const res = await app.request('/payment-vouchers/pv1/post', { method: 'POST' });
    expect(res.status).toBe(200);
    const je = sb.tables.journal_entries.find((r) => r.source_type === 'PV')!;
    expect(String(je.narration)).toMatch(/^Customer refund 2990-MRF-2607-001 — Ah Meng \(2990-SO-2607-001\)/);
    const lines = sb.tables.journal_entry_lines.filter((r) => r.journal_entry_id === je.id || r.je_id === je.id);
    expect(lines.map((l) => [l.account_code, Number(l.debit_sen), Number(l.credit_sen), l.party_type, l.party_name])).toEqual([
      ['300-0000', 30000, 0, 'CUSTOMER', 'Ah Meng'],
      ['310-0010', 0, 30000, 'CUSTOMER', 'Ah Meng'],
    ]);
    expect(sb.tables.payment_vouchers[0]!.status).toBe('POSTED');
    expect(sb.tables.customer_credits).toHaveLength(0);
  });

  test('with a debtor code the credit ledger drops on post and comes back on cancel', async () => {
    const { app, sb } = harness({
      payment_vouchers: [{ ...APPROVED, pv_number: `2990-MRF-${yymm}-002`, debtor_code: 'D001', payee_name: 'Ali' }],
      payment_voucher_lines: [{ ...LINE }],
    });
    expect((await app.request('/payment-vouchers/pv1/post', { method: 'POST' })).status).toBe(200);
    expect(sb.tables.customer_credits).toHaveLength(1);
    expect(sb.tables.customer_credits[0]).toMatchObject({ debtor_code: 'D001', amount_sen: -30000, source_type: 'CUSTOMER_REFUND', source_doc_no: `2990-MRF-${yymm}-002`, company_id: CO });
    expect((await app.request('/payment-vouchers/pv1/cancel', { method: 'POST' })).status).toBe(200);
    expect(sb.tables.payment_vouchers[0]!.status).toBe('CANCELLED');
    expect(sb.tables.journal_entries.some((r) => r.source_type === 'PV_REVERSAL')).toBe(true);
    expect(sb.tables.customer_credits).toHaveLength(2);
    expect(sb.tables.customer_credits[1]).toMatchObject({ debtor_code: 'D001', amount_sen: 30000, source_type: 'CUSTOMER_REFUND_REVERSAL' });
  });
});
