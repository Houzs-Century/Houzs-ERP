/* A Sales Order's refund is a PAYMENT REQUEST for Finance (owner 2026-10-14:
   「sales order 的 refund request 可以让他跑去 payment request，而不是直接去 draft
   pv 吗？因为我可能还会拒绝 … 同时也要确定他在申请人的payment request … 退款申请
   不一定要附件 … 一定要填顾客银行户口号码，名字等等，原因也必填 … A，做」). Pinned
   through the real handlers and routers:
     • the order's Refund button raises a request, not a voucher — the caller's
       own, the customer as payee, the customer's bank and the reason required;
     • while it waits it holds the order's money: a second refund or a
       conversion cannot take it;
     • the requester reads it on Payment Requests WITHOUT the 申请付款 key (their
       own only — option A), raises nothing else there, and may withdraw it;
     • it is never edited and takes no balance;
     • Finance answers it only with a Customer Refund voucher on that order —
       no bill asked, its own amount not standing in the way — and a refund
       voucher answers no other request;
     • Finance's Return is the refusal: the money is back on the order and the
       requester reads why; a cancelled answer puts it back to waiting;
     • requireScmAccess admits a Sales caller to /payment-requests alone.
   Same fake-PostgREST harness as tests/soMoneyConvert.test.ts and
   tests/paymentRequests.test.ts. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { requireScmAccess } from '../src/middleware/auth';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { postSoPaymentHandler } from '../src/scm/routes/mfg-sales-orders';
import { soMoneyHandler, soMoneyRefundHandler } from '../src/scm/routes/so-money-routes';
import { paymentRequests } from '../src/scm/routes/payment-requests';
import { paymentVouchers } from '../src/scm/routes/payment-vouchers';
import { apInvoices } from '../src/scm/routes/ap-invoices';
import { refundRequestState } from '../src/scm/lib/refund-request';
import { refundAnswerRefusal } from '../src/scm/lib/payment-request';

const CO = 2;
/* A cancelled order: RM 700 paid and booked (RM 500 + RM 200). */
const OLD = '2990-SO-2607-010';
/* Another cancelled order of the same customer: RM 300 paid. */
const OLD2 = '2990-SO-2607-024';
const NEW = '2990-SO-2609-050';

const PV_KEYS = ['scm.payment_voucher.create', 'scm.payment_voucher.write', 'scm.payment_voucher.post', 'scm.payment_voucher.cancel'];
/* Works the order; holds no 申请付款 key (the sales team was left out of the grant). */
const SALES = { id: 31, name: 'Sales A', perms: ['scm.access'] };
const SALES_B = { id: 33, name: 'Sales B', perms: ['scm.access'] };
/* Holds the key (Ops Exec has it since #4400). */
const OPS = { id: 32, name: 'Nancy', perms: ['scm.access', 'scm.payment_request.create'] };
const FINANCE = { id: 9, name: 'Chew', perms: PV_KEYS };
const OWNER = { id: 1, name: 'Owner', perms: ['*'] };

const CHART: Row[] = [
  { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '509-0000', account_name: 'DEPOSIT PAY BY CUSTOMER', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '900-0000', account_name: 'GENERAL EXPENSES', account_type: 'EXPENSE', parent_code: null, is_active: true, acc_money: false },
];

const order = (doc_no: string, status: string, over: Row = {}): Row => ({
  doc_no, company_id: CO, status, debtor_name: 'Ah Meng', debtor_code: null, phone: '0123', customer_id: 'cust-1',
  salesperson_id: 'staff-1', access_staff_ids: null, open_to_all: true, updated_at: '2026-08-01T02:00:00Z', local_total_sen: 0, ...over,
});
const pay = (id: string, so: string, paid_at: string, method: string, amount_sen: number): Row => ({
  id, so_doc_no: so, paid_at, method, merchant_provider: null, installment_months: null, online_type: null, approval_code: null,
  amount_sen, account_sheet: null, slip_key: null, collected_by: 'staff-1', note: null, company_id: CO, version: 1,
  created_at: `${paid_at}T03:00:00Z`, created_by: 'u1', is_deposit: false, converted_from_so_doc_no: null,
});
const je = (id: string, jeNo: string, paymentId: string, date: string): Row => ({
  id, je_no: jeNo, company_id: CO, source_type: 'SOPAY', source_doc_no: paymentId, reversed: false, reversed_by_je: null,
  entry_date: date, posted: true, narration: `Payment on ${paymentId}`, total_debit_sen: 0, total_credit_sen: 0,
});

function world() {
  const sb = fakeSb(
    {
      accounts: CHART.map((r) => ({ ...r })),
      acc_account_roles: [],
      acc_bank_letters: [{ company_id: CO, account_code: '310-0010', letter: 'M' }],
      acc_numbering: [],
      acc_company_settings: [],
      acc_deposit_invoices: [],
      acc_credit_notes: [],
      acc_credit_note_lines: [],
      acc_official_receipts: [],
      acc_supplier_advances: [],
      acc_vendor_memory: [],
      acc_payment_requests: [],
      acc_payment_request_files: [],
      acc_pv_files: [],
      acc_bank_statement_matches: [],
      acc_bank_statement_lines: [],
      ap_invoices: [],
      ap_invoice_lines: [],
      acc_ap_invoice_files: [],
      companies: [{ id: CO, code: '2990' }],
      customer_credits: [],
      entity_audit_log: [],
      journal_entries: [
        je('je1', '2990-JE-2607-0001', 'p1', '2026-07-01'),
        je('je2', '2990-JE-2607-0002', 'p2', '2026-07-03'),
        je('je3', '2990-JE-2607-0003', 'p3', '2026-07-10'),
      ],
      journal_entry_lines: [],
      mfg_sales_orders: [order(OLD, 'CANCELLED'), order(OLD2, 'CANCELLED'), order(NEW, 'CONFIRMED')],
      mfg_sales_order_payments: [
        pay('p1', OLD, '2026-07-01', 'transfer', 50_000),
        pay('p2', OLD, '2026-07-03', 'cash', 20_000),
        pay('p3', OLD2, '2026-07-10', 'transfer', 30_000),
      ],
      mfg_so_audit_log: [],
      payment_voucher_lines: [],
      payment_vouchers: [],
      pv_allocations: [],
      sales_invoices: [],
      sales_invoice_payments: [],
      staff: [],
      suppliers: [{ id: 'sup-x', company_id: CO, code: '400-X001', name: 'X SUPPLIES', status: 'ACTIVE' }],
    },
    {},
    [{ table: 'payment_vouchers', column: 'pv_number', name: 'payment_vouchers_pv_number_key' }],
  );
  sb.rpcHandlers.entity_audit_writable = () => true;
  return { sb };
}

function as(w: ReturnType<typeof world>, who: { id: number; name: string; perms: string[] }) {
  const app = new Hono();
  app.onError((e, c) => c.json({ error: 'thrown', message: String((e as Error).stack ?? e) }, 500));
  app.use('*', async (c, next) => {
    c.set('supabase' as never, w.sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never);
    c.set('houzsUser' as never, { id: who.id, name: who.name, permissions_set: new Set(who.perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    await next();
  });
  app.get('/mfg-sales-orders/:docNo/money', soMoneyHandler as never);
  app.post('/mfg-sales-orders/:docNo/money/refund', soMoneyRefundHandler as never);
  app.post('/mfg-sales-orders/:docNo/payments', postSoPaymentHandler as never);
  app.route('/payment-requests', paymentRequests);
  app.route('/payment-vouchers', paymentVouchers);
  app.route('/ap-invoices', apInvoices);
  return async (path: string, method = 'GET', body?: unknown) => {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, {});
    return { status: res.status, body: await res.json() as Row };
  };
}

const REFUND = { amountSen: 40_000, reason: 'Customer cancelled — the sofa is out of stock', bankName: 'Maybank', bankAccountNo: '5123 4567 8901', bankAccountName: 'AH MENG' };
const moneyOf = async (call: ReturnType<typeof as>, docNo: string) => {
  const r = await call(`/mfg-sales-orders/${docNo}/money`);
  expect(r.status).toBe(200);
  return r.body.money as Row;
};
const asked = async (w: ReturnType<typeof world>, who = SALES, body: Row = REFUND, docNo = OLD) => {
  const r = await as(w, who)(`/mfg-sales-orders/${docNo}/money/refund`, 'POST', body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: String(r.body.id), no: String(r.body.requestNo) };
};
/* What Finance's New Customer Refund sends when it answers a request. */
const refundVoucher = (docNo: string, amountSen: number, requestId: string): Row => ({
  purpose: 'CUSTOMER_REFUND', refundSourceType: 'SO', refundSourceDocNo: docNo, refundAmountSen: amountSen,
  payeeName: 'Ah Meng', creditAccountCode: '310-0010', voucherDate: '2026-10-14', lines: [], paymentRequestId: requestId,
});

describe('the Refund button raises a payment request', () => {
  test('the caller\'s own: the customer as payee, the bank and the reason — and no voucher', async () => {
    const w = world();
    const { no } = await asked(w);
    expect(no).toMatch(/PRQ-\d{4}-001$/);
    expect(w.sb.tables.payment_vouchers).toHaveLength(0);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({
      status: 'SUBMITTED', requested_by: 31, requested_by_name: 'Sales A', payee_name: 'Ah Meng', amount_sen: 40_000,
      purpose: REFUND.reason, bank_name: 'Maybank', bank_account_no: '5123 4567 8901', bank_account_name: 'AH MENG',
      refund_source_type: 'SO', refund_source_doc_no: OLD,
    });
    expect(w.sb.tables.entity_audit_log.filter((a) => a.entity_type === 'PAYMENT_REQUEST' && a.action === 'CREATE')).toHaveLength(1);
  });

  test('the reason and the customer\'s bank are required; an older screen\'s note still reads as the reason', async () => {
    const w = world();
    const sales = as(w, SALES);
    const send = (over: Row) => sales(`/mfg-sales-orders/${OLD}/money/refund`, 'POST', { ...REFUND, ...over });
    expect((await send({ reason: '  ' })).body.error).toBe('refund_reason_required');
    expect((await send({ bankName: '' })).body.error).toBe('refund_bank_required');
    expect((await send({ bankAccountName: undefined })).body.error).toBe('refund_bank_required');
    expect((await send({ bankAccountNo: 'N/A' })).body.error).toBe('refund_account_no_invalid');
    expect((await send({ amountSen: 0 })).body.error).toBe('refund_amount_required');
    expect(w.sb.tables.acc_payment_requests).toHaveLength(0);
    const old = await send({ reason: undefined, note: 'Wants the money back' });
    expect(old.status).toBe(201);
    expect(w.sb.tables.acc_payment_requests[0]!.purpose).toBe('Wants the money back');
  });

  test('while it waits it holds the order\'s money: a second refund or a conversion takes only the rest', async () => {
    const w = world();
    const { no } = await asked(w);
    const sales = as(w, SALES);
    const m = await moneyOf(sales, OLD);
    expect(m).toMatchObject({ bookedSen: 70_000, refundedSen: 0, requestedSen: 40_000, remainingSen: 30_000, open: true });
    expect(m.refundRequests.map((r: Row) => [r.requestNo, r.state, r.amountSen, r.reason])).toEqual([[no, 'WAITING', 40_000, REFUND.reason]]);
    const over = await sales(`/mfg-sales-orders/${OLD}/money/refund`, 'POST', { ...REFUND, amountSen: 30_001 });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('refund_exceeds_remaining');
    expect(String(over.body.message)).toContain('400.00 on refund requests waiting for Finance');
    const move = await as(w, OWNER)(`/mfg-sales-orders/${NEW}/payments`, 'POST', { paidAt: '2026-10-14', method: 'converted', convertedFromDocNo: OLD, amountSen: 30_001 });
    expect(move.status).toBe(409);
    expect(String(move.body.message)).toContain('on refund requests waiting for Finance');
  });
});

describe('the requester reads it on Payment Requests (option A)', () => {
  test('without the key: their own only, nothing else raised there; withdrawn, the money is back', async () => {
    const w = world();
    const { id, no } = await asked(w);
    const sales = as(w, SALES);
    const list = await sales('/payment-requests');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ finance: false, mayRaise: false });
    expect(list.body.requests.map((r: Row) => [r.request_no, r.refund_source_doc_no, r.stage])).toEqual([[no, OLD, 'SUBMITTED']]);
    expect((await sales(`/payment-requests/${id}`)).body.request).toMatchObject({ refund_source_doc_no: OLD, stage: 'SUBMITTED' });
    /* Another salesperson sees none of it. */
    const other = as(w, SALES_B);
    expect((await other('/payment-requests')).body.requests).toEqual([]);
    expect((await other(`/payment-requests/${id}`)).status).toBe(404);
    /* No other kind of request, no change. */
    expect((await sales('/payment-requests', 'POST', { payeeName: 'X', amountSen: 100, purpose: 'Anything' })).status).toBe(403);
    expect((await sales(`/payment-requests/${id}`, 'PATCH', { amountSen: 1 })).status).toBe(403);
    expect((await sales(`/payment-requests/${id}/withdraw`, 'POST')).status).toBe(200);
    const m = await moneyOf(sales, OLD);
    expect(m).toMatchObject({ requestedSen: 0, remainingSen: 70_000 });
    expect(m.refundRequests.map((r: Row) => r.state)).toEqual(['WITHDRAWN']);
  });

  test('with the key: it is still never edited and takes no balance', async () => {
    const w = world();
    const { id } = await asked(w, OPS);
    const ops = as(w, OPS);
    expect((await ops('/payment-requests')).body.mayRaise).toBe(true);
    const edit = await ops(`/payment-requests/${id}`, 'PATCH', { amountSen: 1 });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe('refund_request_fixed');
    const balance = await ops(`/payment-requests/${id}/balance`, 'POST', { amountSen: 100 });
    expect(balance.status).toBe(409);
    expect(balance.body.error).toBe('refund_no_balance');
    expect(w.sb.tables.acc_payment_requests).toHaveLength(1);
  });
});

describe('Finance answers it with a Customer Refund on that order', () => {
  test('no bill asked; its own amount does not stand in the way; the voucher then holds the money', async () => {
    const w = world();
    const { id } = await asked(w, SALES, { ...REFUND, amountSen: 70_000 });
    const fin = as(w, FINANCE);
    /* What New Customer Refund reads: every waiting request held, but not the one it answers. */
    expect((await fin(`/payment-vouchers/refund-source?type=SO&docNo=${OLD}`)).body.source).toMatchObject({ requestedSen: 70_000, refundableSen: 0 });
    expect((await fin(`/payment-vouchers/refund-source?type=SO&docNo=${OLD}&excludeRequestId=${id}`)).body.source).toMatchObject({ requestedSen: 0, refundableSen: 70_000 });

    const pv = await fin('/payment-vouchers', 'POST', refundVoucher(OLD, 70_000, id));
    expect(pv.status, JSON.stringify(pv.body)).toBe(201);
    expect(w.sb.tables.acc_payment_requests[0]).toMatchObject({ status: 'VOUCHERED', pv_id: pv.body.id });
    expect(w.sb.tables.payment_vouchers[0]).toMatchObject({ purpose: 'CUSTOMER_REFUND', refund_source_doc_no: OLD, total_sen: 70_000, status: 'DRAFT' });
    const sales = as(w, SALES);
    expect((await sales(`/payment-requests/${id}`)).body.request).toMatchObject({ stage: 'PROCESSING', voucher: { id: pv.body.id } });
    /* Held once: by the voucher now, not by the request too. */
    const m = await moneyOf(sales, OLD);
    expect(m).toMatchObject({ refundedSen: 70_000, requestedSen: 0, remainingSen: 0 });
    expect(m.refundRequests.map((r: Row) => [r.state, r.pvNumber])).toEqual([['ANSWERED', pv.body.pvNumber]]);
  });

  test('a plain voucher, a refund on another order or an AP invoice is refused, and nothing stands', async () => {
    const w = world();
    const { id } = await asked(w);
    const fin = as(w, FINANCE);
    const plain = await fin('/payment-vouchers', 'POST', {
      payeeName: 'Ah Meng', creditAccountCode: '310-0010', voucherDate: '2026-10-14', purpose: 'OTHER', paymentRequestId: id,
      lines: [{ debitAccountCode: '900-0000', description: 'Refund', amountSen: 40_000 }],
    });
    expect(plain.status).toBe(409);
    expect(plain.body.error).toBe('refund_request_needs_refund');
    const elsewhere = await fin('/payment-vouchers', 'POST', refundVoucher(OLD2, 30_000, id));
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.error).toBe('refund_request_needs_refund');
    expect(w.sb.tables.payment_vouchers).toHaveLength(0);
    const inv = await as(w, OWNER)('/ap-invoices', 'POST', {
      supplierId: 'sup-x', supplierInvoiceRef: 'X-1', invoiceDate: '2026-10-14', paymentRequestId: id,
      lines: [{ debitAccountCode: '900-0000', description: 'Refund', amountSen: 40_000 }],
    });
    expect(inv.status).toBe(409);
    expect(inv.body.error).toBe('refund_request_needs_refund');
    expect(w.sb.tables.ap_invoices).toHaveLength(0);
    expect(w.sb.tables.acc_payment_requests[0]!.status).toBe('SUBMITTED');
  });

  test('a refund voucher answers no other request', async () => {
    const w = world();
    const r = await as(w, OPS)('/payment-requests', 'POST', { payeeName: 'X SUPPLIES', amountSen: 10_000, purpose: 'Repair' });
    expect(r.status).toBe(201);
    const wrong = await as(w, FINANCE)('/payment-vouchers', 'POST', refundVoucher(OLD, 10_000, String(r.body.request.id)));
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toBe('request_not_a_refund');
    expect(w.sb.tables.payment_vouchers).toHaveLength(0);
  });
});

describe('Finance\'s Return is the refusal', () => {
  test('the money is back on the order; the requester reads why there and on the request', async () => {
    const w = world();
    const { id } = await asked(w);
    const why = 'Customer agreed to change model — convert it instead';
    expect((await as(w, FINANCE)(`/payment-requests/${id}/return`, 'POST', { note: why })).status).toBe(200);
    const sales = as(w, SALES);
    const m = await moneyOf(sales, OLD);
    expect(m).toMatchObject({ requestedSen: 0, remainingSen: 70_000 });
    expect(m.refundRequests.map((r: Row) => [r.state, r.financeNote])).toEqual([['RETURNED', why]]);
    expect((await sales(`/payment-requests/${id}`)).body.request).toMatchObject({ stage: 'RETURNED', finance_note: why });
  });

  test('a cancelled answer puts it back to waiting — it holds the money again', async () => {
    const w = world();
    const { id } = await asked(w);
    const fin = as(w, FINANCE);
    const pv = await fin('/payment-vouchers', 'POST', refundVoucher(OLD, 40_000, id));
    expect(pv.status).toBe(201);
    w.sb.tables.payment_vouchers[0]!.status = 'CANCELLED';
    const m = await moneyOf(as(w, SALES), OLD);
    expect(m).toMatchObject({ refundedSen: 0, requestedSen: 40_000, remainingSen: 30_000 });
    expect(m.refundRequests.map((r: Row) => r.state)).toEqual(['WAITING']);
  });
});

describe('requireScmAccess admits a Sales caller to /payment-requests alone', () => {
  const gate = (user: Row) => {
    const app = new Hono();
    app.use('*', async (c, next) => { c.set('user' as never, user as never); await next(); });
    app.use('/api/scm/*', requireScmAccess as never);
    app.all('/api/scm/*', (c) => c.json({ ok: true }));
    return (path: string) => app.request(path);
  };
  test('a salesperson by position reaches their requests, not the vouchers', async () => {
    const rep = gate({ id: 31, permissions_set: new Set([]), page_access: {}, position_name: 'Sales Executive' });
    expect((await rep('/api/scm/payment-requests')).status).toBe(200);
    expect((await rep('/api/scm/payment-requests/abc')).status).toBe(200);
    expect((await rep('/api/scm/payment-vouchers')).status).toBe(403);
    const driver = gate({ id: 40, permissions_set: new Set([]), page_access: {}, position_name: 'Driver' });
    expect((await driver('/api/scm/payment-requests')).status).toBe(403);
  });
});

describe('the pure readings', () => {
  test('a refund request\'s state', () => {
    expect(refundRequestState('SUBMITTED', false)).toBe('WAITING');
    expect(refundRequestState('VOUCHERED', true)).toBe('ANSWERED');
    expect(refundRequestState('VOUCHERED', false)).toBe('WAITING');
    expect(refundRequestState('REJECTED', false)).toBe('RETURNED');
    expect(refundRequestState('WITHDRAWN', true)).toBe('WITHDRAWN');
  });

  test('which answer a request takes', () => {
    const refund = { request_no: 'PRQ-1', refund_source_doc_no: OLD };
    const plain = { request_no: 'PRQ-2', refund_source_doc_no: null };
    const voucher = (docNo: string) => ({ kind: 'PV' as const, body: { purpose: 'customer_refund', refundSourceType: 'so', refundSourceDocNo: ` ${docNo} ` } });
    expect(refundAnswerRefusal(refund, voucher(OLD))).toBeNull();
    expect(refundAnswerRefusal(refund, voucher(OLD2))?.error).toBe('refund_request_needs_refund');
    expect(refundAnswerRefusal(refund, { kind: 'PV', body: { purpose: 'OTHER' } })?.error).toBe('refund_request_needs_refund');
    expect(refundAnswerRefusal(refund, { kind: 'API' })?.error).toBe('refund_request_needs_refund');
    expect(refundAnswerRefusal(plain, voucher(OLD))?.error).toBe('request_not_a_refund');
    expect(refundAnswerRefusal(plain, { kind: 'PV', body: { purpose: 'OTHER' } })).toBeNull();
    expect(refundAnswerRefusal(plain, { kind: 'API' })).toBeNull();
  });
});
