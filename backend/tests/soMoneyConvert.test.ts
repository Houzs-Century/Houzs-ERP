/* The money on a cancelled Sales Order and its two exits (owner 2026-09-15;
   docs/bugs/0927). Pinned:
     • the money panel: what was paid (booked), refunded, moved, and what is
       left; the customer's other cancelled orders with money;
     • CONVERT is a payment row on the new order with method `converted`: the
       cancelled order's first payment day and collector, the source named,
       the transfer Dr AR (old customer) / Cr AR (new customer) booked, no
       receipt; the cancelled order's remaining goes down;
     • the ceilings: more than what is left, an order that is not cancelled,
       an order moving money to itself, an unknown source;
     • REFUND from the panel: a Customer Refund voucher DRAFT for Finance —
       the customer as payee, the default bank, the amount — and it takes
       from the same remaining a conversion does;
     • un-convert: deleting the converted row reverses the transfer and the
       money is back on the cancelled order;
     • under the deposit-invoice switch: the moved amount comes off the old
       invoice by a credit note carrying the converted row, and the new order
       gets its own invoice dated the day of the move;
     • Finance's list of cancelled orders still holding money;
     • since 2026-09-16 a LIVE order too: convert while it keeps its deposit
       fraction of the total (2990 50%, Houzs 30%), refund with no floor; the
       money that left is MIRRORED on it as a negative row that follows the
       converted row (books nothing, goes when it goes) and is never edited
       or deleted by hand; the any-status list beside Finance's.
   Real handlers, fake PostgREST (fakeSb). */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deleteSoPaymentHandler, postSoPaymentHandler } from '../src/scm/routes/mfg-sales-orders';
import { cancelledWithMoneyHandler, ordersWithMoneyHandler, soConvertSourcesHandler, soMoneyHandler, soMoneyRefundHandler } from '../src/scm/routes/so-money-routes';
import { soRouterSource } from './lib/so-router-source';
const rawSo = soRouterSource();

const CO = 2;
const OLD = '2990-SO-2607-010';
const OLD2 = '2990-SO-2607-024';
const NEW = '2990-SO-2609-050';
const OTHER = '2990-SO-2609-051';
/* A live order of another customer: RM 1,500 total, RM 1,000 paid and booked. */
const LIVE = '2990-SO-2609-060';

const CHART: Row[] = [
  { company_id: CO, account_code: '300-0000', account_name: 'ACCOUNT RECEIVEABLE', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '320-0000', account_name: 'CASH IN HAND', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: true },
  { company_id: CO, account_code: '326-0000', account_name: 'CARD CLEARING', account_type: 'ASSET', parent_code: null, is_active: true, acc_money: false },
  { company_id: CO, account_code: '509-0000', account_name: 'DEPOSIT PAY BY CUSTOMER', account_type: 'INCOME', parent_code: null, is_active: true, acc_money: false },
];

const order = (doc_no: string, status: string, over: Row = {}): Row => ({
  doc_no, company_id: CO, status, debtor_name: 'Ah Meng', debtor_code: null, phone: '0123', customer_id: 'cust-1',
  salesperson_id: 'staff-1', access_staff_ids: null, open_to_all: true, updated_at: '2026-08-01T02:00:00Z', ...over,
});
const pay = (id: string, so: string, paid_at: string, method: string, amount_sen: number, over: Row = {}): Row => ({
  id, so_doc_no: so, paid_at, method, merchant_provider: null, installment_months: null, online_type: null, approval_code: null,
  amount_sen, account_sheet: null, slip_key: null, collected_by: 'staff-1', note: null, company_id: CO, version: 1,
  created_at: `${paid_at}T03:00:00Z`, created_by: 'u1', is_deposit: false, converted_from_so_doc_no: null, ...over,
});
const je = (id: string, jeNo: string, paymentId: string, date: string): Row => ({
  id, je_no: jeNo, company_id: CO, source_type: 'SOPAY', source_doc_no: paymentId, reversed: false, reversed_by_je: null,
  entry_date: date, posted: true, narration: `Payment on ${paymentId}`, total_debit_sen: 0, total_credit_sen: 0,
});

function harness(tables: Record<string, Row[]> = {}) {
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
      companies: [{ id: CO, code: '2990' }],
      customer_credits: [],
      entity_audit_log: [],
      journal_entries: [
        je('je1', '2990-JE-2607-0001', 'p1', '2026-07-01'),
        je('je2', '2990-JE-2607-0002', 'p2', '2026-07-03'),
        je('je3', '2990-JE-2607-0003', 'p3', '2026-07-10'),
        je('je4', '2990-JE-2608-0004', 'p4', '2026-08-20'),
      ],
      journal_entry_lines: [],
      mfg_sales_orders: [
        order(OLD, 'CANCELLED'), order(OLD2, 'CANCELLED'), order(NEW, 'CONFIRMED'), order(OTHER, 'CONFIRMED', { debtor_name: 'Someone Else', customer_id: 'cust-2', phone: '0999' }),
        order(LIVE, 'CONFIRMED', { debtor_name: 'Lim Ah Lian', customer_id: 'cust-3', phone: '0777', local_total_sen: 150_000 }),
      ],
      mfg_sales_order_payments: [
        pay('p1', OLD, '2026-07-01', 'transfer', 50_000, { online_type: 'DuitNow', slip_key: 'slips/p1-duitnow.jpg' }),
        pay('p2', OLD, '2026-07-03', 'cash', 20_000),
        pay('p3', OLD2, '2026-07-10', 'merchant', 30_000, { merchant_provider: 'GHL', approval_code: '123456' }),
        pay('p4', LIVE, '2026-08-20', 'merchant', 100_000, { merchant_provider: 'PBB', approval_code: '654321' }),
      ],
      mfg_so_audit_log: [],
      payment_voucher_lines: [],
      payment_vouchers: [],
      pv_allocations: [],
      sales_invoices: [],
      sales_invoice_payments: [],
      staff: [],
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
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Sales A' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Sales A', permissions_set: ['*'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990' }] as never);
    c.set('companyCode' as never, '2990' as never);
    c.set('env' as never, {} as never);
    await next();
  });
  app.get('/mfg-sales-orders/cancelled-with-money', cancelledWithMoneyHandler as never);
  app.get('/mfg-sales-orders/with-money', ordersWithMoneyHandler as never);
  app.get('/mfg-sales-orders/:docNo/money', soMoneyHandler as never);
  app.post('/mfg-sales-orders/:docNo/money/refund', soMoneyRefundHandler as never);
  app.get('/mfg-sales-orders/:docNo/convert-sources', soConvertSourcesHandler as never);
  app.post('/mfg-sales-orders/:docNo/payments', postSoPaymentHandler as never);
  app.delete('/mfg-sales-orders/:docNo/payments/:id', deleteSoPaymentHandler as never);
  return { app, sb };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const money = async (app: Hono, docNo: string) => {
  const res = await app.request(`/mfg-sales-orders/${docNo}/money`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as { money: Record<string, any>; others: Array<Record<string, any>> };
};
const convert = (app: Hono, to: string, from: string, amountSen: number) =>
  app.request(`/mfg-sales-orders/${to}/payments`, json({ paidAt: '2026-09-15', method: 'converted', convertedFromDocNo: from, amountSen }));

describe('the money panel on a cancelled order', () => {
  test('paid (booked), refunded, moved, remaining — and the customer\'s other cancelled orders with money', async () => {
    const { app } = harness();
    const { money: m, others } = await money(app, OLD);
    expect(m).toMatchObject({ docNo: OLD, status: 'CANCELLED', cancelled: true, bookedSen: 70_000, refundedSen: 0, convertedSen: 0, remainingSen: 70_000, open: true, reason: null, keepFraction: 0, keepSen: 0, movableSen: 70_000 });
    expect(m.payments.map((p: Row) => [p.id, p.booked, p.paidOn])).toEqual([['p1', true, '2026-07-01'], ['p2', true, '2026-07-03']]);
    expect(others.map((o) => [o.docNo, o.remainingSen])).toEqual([[OLD2, 30_000]]);
    /* A live order with nothing on it has nothing to give. */
    const live = await money(app, NEW);
    expect(live.money).toMatchObject({ cancelled: false, open: false, bookedSen: 0 });
    expect(live.money.reason).toMatch(/collected nothing/);
    expect(live.others).toEqual([]);
  });

  test('the sources a new order may draw on: the customer\'s cancelled orders, plus one named outright', async () => {
    const { app } = harness();
    const res = await app.request(`/mfg-sales-orders/${NEW}/convert-sources`);
    expect(res.status).toBe(200);
    const b = await res.json() as { sources: Array<Record<string, any>> };
    expect(b.sources.map((s) => [s.docNo, s.remainingSen, s.movableSen, s.customer])).toEqual([[OLD, 70_000, 70_000, 'Ah Meng'], [OLD2, 30_000, 30_000, 'Ah Meng']]);
    /* Another customer's order is not listed unless named. */
    const other = await (await app.request(`/mfg-sales-orders/${OTHER}/convert-sources`)).json() as { sources: Row[] };
    expect(other.sources).toEqual([]);
    const named = await (await app.request(`/mfg-sales-orders/${OTHER}/convert-sources?also=${OLD2}`)).json() as { sources: Row[] };
    expect(named.sources.map((s) => s.docNo)).toEqual([OLD2]);
  });
});

describe('convert — a payment row on the new order', () => {
  test('the row keeps the cancelled order\'s first day and collector, names its source, books the transfer, and gets no receipt', async () => {
    const { app, sb } = harness();
    const res = await convert(app, NEW, OLD, 30_000);
    expect(res.status, await res.clone().text()).toBe(201);
    const { payment } = await res.json() as { payment: Row };
    expect(payment).toMatchObject({ so_doc_no: NEW, method: 'converted', amount_sen: 30_000, paid_at: '2026-07-01', collected_by: 'staff-1', account_sheet: `Converted from ${OLD}`, converted_from_so_doc_no: OLD, note: `Converted from ${OLD}` });
    /* The proof rides along (owner 2026-09-16): the first booked payment's slip, the same R2 object on both orders. */
    expect(payment.slip_key).toBe('slips/p1-duitnow.jpg');
    /* The transfer: Dr AR / Cr AR, both on the customer, dated the day of the move. */
    const entry = sb.tables.journal_entries.find((j) => j.source_type === 'SOCONV' && j.source_doc_no === payment.id)!;
    expect(entry).toBeTruthy();
    expect(String(entry.narration)).toContain(`Money on ${OLD} moved to ${NEW}`);
    const lines = sb.tables.journal_entry_lines.filter((l) => l.journal_entry_id === entry.id);
    expect(lines.map((l) => [l.account_code, l.debit_sen, l.credit_sen, l.party_code])).toEqual([['300-0000', 30_000, 0, 'cust-1'], ['300-0000', 0, 30_000, 'cust-1']]);
    expect(sb.tables.acc_official_receipts).toHaveLength(0);
    /* The cancelled order: RM 300 moved, RM 400 left; the new order holds the money. */
    const { money: old } = await money(app, OLD);
    expect(old).toMatchObject({ convertedSen: 30_000, remainingSen: 40_000, open: true });
    expect(old.conversions.map((x: Row) => [x.toDocNo, x.amountSen])).toEqual([[NEW, 30_000]]);
    const { money: fresh } = await money(app, NEW);
    expect(fresh.payments.map((p: Row) => [p.method, p.booked, p.convertedFrom])).toEqual([['converted', true, OLD]]);
    expect(fresh.bookedSen).toBe(30_000);
  });

  test('the ceilings: what is left, a live source, the same order, an unknown one', async () => {
    const { app } = harness();
    expect((await convert(app, NEW, OLD, 70_001)).status).toBe(409);
    expect(((await (await convert(app, NEW, OLD, 70_001)).json()) as { error: string }).error).toBe('convert_exceeds_remaining');
    expect(((await (await convert(app, NEW, OTHER, 100)).json()) as { error: string }).error).toBe('convert_not_allowed');
    expect((await convert(app, OLD, OLD, 100)).status).toBe(400);
    expect((await convert(app, NEW, '2990-SO-0000-000', 100)).status).toBe(404);
    /* Two moves that together exceed it: the second is refused by exactly the remainder. */
    expect((await convert(app, NEW, OLD, 50_000)).status).toBe(201);
    const second = await convert(app, OTHER, OLD, 20_001);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { message: string }).message).toContain('200.00 left to move');
    expect((await convert(app, OTHER, OLD, 20_000)).status).toBe(201);
  });

  test('un-convert: deleting the row reverses the transfer and the money is back on the cancelled order', async () => {
    const { app, sb } = harness();
    const { payment } = await (await convert(app, NEW, OLD, 30_000)).json() as { payment: Row };
    /* Keyed today, so the same-day gate lets the salesperson take it back. */
    const row = sb.tables.mfg_sales_order_payments.find((p) => p.id === payment.id)!;
    row.created_at = new Date().toISOString();
    row.version = 1; // the real column defaults to 1; the fake insert leaves it unset
    const del = await app.request(`/mfg-sales-orders/${NEW}/payments/${payment.id}?version=1`, { method: 'DELETE' });
    expect(del.status, await del.clone().text()).toBe(200);
    const transfer = sb.tables.journal_entries.find((j) => j.source_type === 'SOCONV' && j.source_doc_no === payment.id)!;
    expect(transfer.reversed).toBe(true);
    expect(sb.tables.journal_entries.some((j) => j.source_type === 'SOCONV_REVERSAL')).toBe(true);
    const { money: old } = await money(app, OLD);
    expect(old).toMatchObject({ convertedSen: 0, remainingSen: 70_000 });
  });

  test('the PATCH door refuses a converted row — it is moved back by deleting it', () => {
    expect(rawSo).toContain("if (String(before.method) === 'converted') return c.json({ error: 'converted_row_not_editable'");
  });
});

describe('refund — a voucher draft for Finance from the panel', () => {
  test('the draft: the customer as payee, the default bank, the amount; it takes from the same remaining', async () => {
    const { app, sb } = harness();
    expect((await convert(app, NEW, OLD, 30_000)).status).toBe(201);
    const res = await app.request(`/mfg-sales-orders/${OLD}/money/refund`, json({ amountSen: 40_000, note: 'customer wants it back' }));
    expect(res.status, await res.clone().text()).toBe(201);
    const { pvNumber } = await res.json() as { id: string; pvNumber: string };
    expect(pvNumber).toMatch(/Draft/);
    const pv = sb.tables.payment_vouchers[0]!;
    expect(pv).toMatchObject({ purpose: 'CUSTOMER_REFUND', status: 'DRAFT', refund_source_type: 'SO', refund_source_doc_no: OLD, payee_name: 'Ah Meng', credit_account_code: '310-0010', total_sen: 40_000, customer_id: 'cust-1' });
    expect(String(pv.notes)).toContain(`Refund requested from ${OLD} by Sales A`);
    expect(String(pv.notes)).toContain('customer wants it back');
    expect(sb.tables.payment_voucher_lines.map((l) => [l.debit_account_code, l.amount_sen])).toEqual([['300-0000', 40_000]]);
    const { money: old } = await money(app, OLD);
    expect(old).toMatchObject({ bookedSen: 70_000, convertedSen: 30_000, refundedSen: 40_000, remainingSen: 0, open: false });
    expect(old.refunds.map((r: Row) => [r.pvNumber, r.status, r.totalSen])).toEqual([[pvNumber, 'DRAFT', 40_000]]);
    /* Nothing is left for either exit. */
    expect((await convert(app, OTHER, OLD, 1)).status).toBe(409);
    expect((await app.request(`/mfg-sales-orders/${OLD}/money/refund`, json({ amountSen: 1 }))).status).toBe(409);
  });

  test('a refund beyond what is left is refused with the figures', async () => {
    const { app } = harness();
    expect((await convert(app, NEW, OLD, 50_000)).status).toBe(201);
    const res = await app.request(`/mfg-sales-orders/${OLD}/money/refund`, json({ amountSen: 20_001 }));
    expect(res.status).toBe(409);
    const b = await res.json() as { error: string; message: string };
    expect(b.error).toBe('refund_exceeds_remaining');
    expect(b.message).toContain('200.00 left');
    expect(b.message).toContain('500.00 moved to other orders');
  });
});

describe('under the deposit-invoice switch', () => {
  const DI: Row = {
    id: 'di1', company_id: CO, di_number: '2990DI-2607-001', payment_source: 'SOPAY', payment_id: 'p1', so_doc_no: OLD,
    party_code: 'cust-1', party_name: 'Ah Meng', invoice_date: '2026-07-01', amount_sen: 50_000, method: 'transfer', status: 'ISSUED',
    je_no: '2990-JE-2607-0009', credit_note_id: null, cancel_reason: null, created_at: '2026-07-01T03:00:00Z', created_by: 'u1', cancelled_at: null, cancelled_by: null,
  };
  const withSwitch = () => harness({
    acc_company_settings: [{ company_id: CO, deposit_invoice_enabled: true, deposit_invoice_from: '2026-06-01' }],
    acc_deposit_invoices: [{ ...DI }],
  });

  test('the moved amount comes off the old invoice by a credit note carrying the converted row; the new order gets its own invoice dated the day of the move', async () => {
    const { app, sb } = withSwitch();
    const { payment } = await (await convert(app, NEW, OLD, 30_000)).json() as { payment: Row };
    const notes = sb.tables.acc_credit_notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'CN', source_doc_no: '2990DI-2607-001', so_doc_no: OLD, total_sen: 30_000, converted_payment_id: payment.id, refund_pv_id: null, status: 'POSTED' });
    expect(String(notes[0]!.reason)).toContain(`Moved to ${NEW}`);
    /* Part of the invoice: it still stands for the RM 200 left. */
    expect(sb.tables.acc_deposit_invoices.find((d) => d.id === 'di1')!.credit_note_id).toBeNull();
    const fresh = sb.tables.acc_deposit_invoices.find((d) => d.so_doc_no === NEW)!;
    expect(fresh).toBeTruthy();
    expect(fresh).toMatchObject({ payment_id: payment.id, amount_sen: 30_000, method: 'converted', status: 'ISSUED' });
    expect(String(fresh.invoice_date)).toBe(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
    /* Sales stands once: the old invoice's 509, its note back, the new invoice's 509. */
    const on509 = sb.tables.journal_entry_lines.filter((l) => l.account_code === '509-0000');
    expect(on509.reduce((s, l) => s + Number(l.debit_sen) - Number(l.credit_sen), 0)).toBe(0);
  });

  test('un-convert cancels the note and the new invoice; the old invoice stands whole again', async () => {
    const { app, sb } = withSwitch();
    const { payment } = await (await convert(app, NEW, OLD, 30_000)).json() as { payment: Row };
    const row = sb.tables.mfg_sales_order_payments.find((p) => p.id === payment.id)!;
    row.created_at = new Date().toISOString();
    row.version = 1; // the real column defaults to 1; the fake insert leaves it unset
    const del = await app.request(`/mfg-sales-orders/${NEW}/payments/${payment.id}?version=1`, { method: 'DELETE' });
    expect(del.status, await del.clone().text()).toBe(200);
    expect(sb.tables.acc_credit_notes.map((n) => n.status)).toEqual(['CANCELLED']);
    expect(sb.tables.acc_deposit_invoices.find((d) => d.so_doc_no === NEW)!.status).toBe('CANCELLED');
    const { money: old } = await money(app, OLD);
    expect(old.remainingSen).toBe(70_000);
  });
});

describe('Finance\'s list', () => {
  test('every cancelled order still holding money, with what is left', async () => {
    const { app } = harness();
    expect((await convert(app, NEW, OLD2, 30_000)).status).toBe(201);
    const res = await app.request('/mfg-sales-orders/cancelled-with-money');
    expect(res.status).toBe(200);
    const b = await res.json() as { orders: Array<Record<string, any>>; totalRemainingSen: number };
    expect(b.orders.map((o) => [o.docNo, o.bookedSen, o.remainingSen])).toEqual([[OLD, 70_000, 70_000]]);
    expect(b.totalRemainingSen).toBe(70_000);
  });
});

describe('the order create takes a converted row too', () => {
  /* The create's split-payment loop is not mounted here (it is the whole
     order create); the source is pinned the way soCreateDepositBooks.test.ts
     pins the booking hook: every converted row is checked against its
     source's remaining BEFORE the header exists, and lands with the source
     named, the source's day and collector, and the sheet that says so. */
  test('checked before the header, all-or-nothing; the row carries the source, its day, its collector', () => {
    expect(rawSo).toContain("const g = await convertGuard(sb, Number(companyId), { fromDocNo: p.convertedFromDocNo, toDocNo: '', amountSen: p.amountSen });");
    expect(rawSo).toContain('if (!g.ok) { await rollbackPwpClaims(); return c.json({ error: g.error, message: g.message }, g.status); }');
    expect(rawSo).toContain("...(plan ? { converted_from_so_doc_no: plan.fromDocNo } : {}),");
    expect(rawSo).toContain('paid_at:            plan ? plan.paidAt : paidAt,');
    expect(rawSo).toContain('collected_by:       plan ? plan.collectedBy : ((body.salespersonId as string) ?? callerStaffId),');
    expect(rawSo).toContain('account_sheet:      plan ? `Converted from ${plan.fromDocNo}` : deriveAccountSheet(p.method, merchantProvider, null),');
    expect(rawSo).toContain('slip_key:           posPaymentSlipKeys![i] ?? (plan ? plan.slipKey : null),');
    /* The insert hands the booking hook the columns a converted row's entry needs. */
    expect(rawSo).toContain("select('id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id, converted_from_so_doc_no, created_at, created_by').single();");
  });
});

describe('Finance\'s list, narrowed to one customer', () => {
  test('?phone= lists only that customer\'s cancelled orders with money — the New SO page has no order yet (docs/bugs/0931)', async () => {
    const { app } = harness({
      mfg_sales_orders: [order(OLD, 'CANCELLED'), order(OLD2, 'CANCELLED', { debtor_name: 'Someone Else', customer_id: 'cust-2', phone: '0999' }), order(NEW, 'CONFIRMED')],
    });
    const mine = await (await app.request('/mfg-sales-orders/cancelled-with-money?phone=0123')).json() as { orders: Array<Record<string, any>> };
    expect(mine.orders.map((o) => o.docNo)).toEqual([OLD]);
    const theirs = await (await app.request('/mfg-sales-orders/cancelled-with-money?phone=0999')).json() as { orders: Array<Record<string, any>> };
    expect(theirs.orders.map((o) => [o.docNo, o.remainingSen])).toEqual([[OLD2, 30_000]]);
    const nobody = await (await app.request('/mfg-sales-orders/cancelled-with-money?phone=0000')).json() as { orders: Row[] };
    expect(nobody.orders).toEqual([]);
  });
});

describe('the proof rides with the money (owner 2026-09-16: attachment 可以带过来)', () => {
  test('a source whose first payment carries no slip hands over the first slip any of its payments has; none at all leaves the row slip-less', async () => {
    const { app } = harness({
      mfg_sales_order_payments: [
        pay('p1', OLD, '2026-07-01', 'transfer', 50_000, { online_type: 'DuitNow' }),
        pay('p2', OLD, '2026-07-03', 'cash', 20_000, { slip_key: 'slips/p2-cash.jpg' }),
        pay('p3', OLD2, '2026-07-10', 'merchant', 30_000, { merchant_provider: 'GHL', approval_code: '123456' }),
      ],
    });
    const { payment } = await (await convert(app, NEW, OLD, 30_000)).json() as { payment: Row };
    expect(payment.slip_key).toBe('slips/p2-cash.jpg');
    const { payment: bare } = await (await convert(app, OTHER, OLD2, 10_000)).json() as { payment: Row };
    expect(bare.slip_key).toBeNull();
  });
});

describe('a LIVE order (owner 2026-09-16) — money may leave it above its deposit floor', () => {
  const mirrorOf = (sb: ReturnType<typeof harness>['sb'], paymentId: string) =>
    sb.tables.mfg_sales_order_payments.find((p) => p.mirror_of_payment_id === paymentId) ?? null;

  test('the panel: total, the fraction it keeps (2990: 50%, transport included), what may move; a refund has no floor', async () => {
    const { app } = harness();
    const { money: m, others } = await money(app, LIVE);
    expect(m).toMatchObject({ docNo: LIVE, cancelled: false, open: true, reason: null, bookedSen: 100_000, remainingSen: 100_000, totalSen: 150_000, keepFraction: 0.5, keepSen: 75_000, movableSen: 25_000 });
    expect(others).toEqual([]);
    /* Houzs keeps 30%. */
    const houzs = harness({ companies: [{ id: CO, code: 'HOUZS' }] });
    const { money: h } = await money(houzs.app, LIVE);
    expect(h).toMatchObject({ keepFraction: 0.3, keepSen: 45_000, movableSen: 55_000 });
  });

  test('convert: more than the floor allows is refused with the figures; up to it moves, and the order MIRRORS the money that left', async () => {
    const { app, sb } = harness();
    const over = await convert(app, NEW, LIVE, 25_001);
    expect(over.status).toBe(409);
    const refusal = await over.json() as { error: string; message: string };
    expect(refusal.error).toBe('convert_keeps_deposit');
    expect(refusal.message).toContain('keeps RM 750.00 (50% of RM 1,500.00)');
    expect(refusal.message).toContain('RM 250.00 can move');

    const res = await convert(app, NEW, LIVE, 25_000);
    expect(res.status, await res.clone().text()).toBe(201);
    const { payment } = await res.json() as { payment: Row };
    expect(payment).toMatchObject({ so_doc_no: NEW, method: 'converted', amount_sen: 25_000, paid_at: '2026-08-20', converted_from_so_doc_no: LIVE });
    /* The mirror on the live order: negative, dated the day of the move, naming where the money went. */
    const mirror = mirrorOf(sb, String(payment.id))!;
    expect(mirror).toBeTruthy();
    expect(mirror).toMatchObject({ so_doc_no: LIVE, method: 'converted', amount_sen: -25_000, converted_to_so_doc_no: NEW, account_sheet: `Moved to ${NEW}` });
    expect(String(mirror.paid_at)).toBe(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10));
    /* It books nothing: the transfer is the accounting. The order's paid total is what the rows sum to. */
    expect(sb.tables.journal_entries.filter((j) => j.source_doc_no === mirror.id)).toEqual([]);
    expect(sb.tables.mfg_sales_order_payments.filter((p) => p.so_doc_no === LIVE).reduce((t, p) => t + Number(p.amount_sen), 0)).toBe(75_000);
    /* The audit says the system did it. */
    const audit = sb.tables.mfg_so_audit_log.find((a) => a.so_doc_no === LIVE && a.action === 'ADD_PAYMENT')!;
    expect(audit).toMatchObject({ source: 'automation', payment_id: mirror.id });
    /* The pool never counts the mirror: RM 750 left, none of it movable, all of it refundable. */
    const { money: after } = await money(app, LIVE);
    expect(after).toMatchObject({ bookedSen: 100_000, convertedSen: 25_000, remainingSen: 75_000, movableSen: 0, open: true });
    expect(after.payments.map((p: Row) => p.id)).toEqual(['p4']);
    expect((await convert(app, OTHER, LIVE, 1)).status).toBe(409);
    expect((await app.request(`/mfg-sales-orders/${LIVE}/money/refund`, json({ amountSen: 75_000, note: 'sofa arrived scratched' }))).status).toBe(201);
  });

  test('un-convert takes the mirror with it; the mirror itself cannot be deleted or edited by hand', async () => {
    const { app, sb } = harness();
    const { payment } = await (await convert(app, NEW, LIVE, 20_000)).json() as { payment: Row };
    const mirror = mirrorOf(sb, String(payment.id))!;
    mirror.created_at = new Date().toISOString(); mirror.version = 1;
    const byHand = await app.request(`/mfg-sales-orders/${LIVE}/payments/${mirror.id}?version=1`, { method: 'DELETE' });
    expect(byHand.status).toBe(409);
    expect(((await byHand.json()) as { error: string }).error).toBe('mirror_row_not_deletable');
    expect(rawSo).toContain("reason: Number(before.amount_sen) < 0 ? 'This row follows money that left the order");

    const row = sb.tables.mfg_sales_order_payments.find((p) => p.id === payment.id)!;
    row.created_at = new Date().toISOString(); row.version = 1;
    const del = await app.request(`/mfg-sales-orders/${NEW}/payments/${payment.id}?version=1`, { method: 'DELETE' });
    expect(del.status, await del.clone().text()).toBe(200);
    expect(mirrorOf(sb, String(payment.id))).toBeNull();
    expect(sb.tables.mfg_so_audit_log.filter((a) => a.so_doc_no === LIVE).map((a) => [a.action, a.source, a.note])).toEqual([['ADD_PAYMENT', 'automation', `Money moved to ${NEW}`], ['DELETE_PAYMENT', 'automation', `money moved to ${NEW} moved back`]]);
    const { money: back } = await money(app, LIVE);
    expect(back).toMatchObject({ remainingSen: 100_000, movableSen: 25_000 });
  });

  test('the lists: Finance\'s is cancelled orders only; the any-status one carries the live order for what it may give', async () => {
    const { app } = harness();
    const cancelled = await (await app.request('/mfg-sales-orders/cancelled-with-money')).json() as { orders: Row[] };
    expect(cancelled.orders.map((o) => o.docNo)).toEqual([OLD, OLD2]);
    const any = await (await app.request('/mfg-sales-orders/with-money')).json() as { orders: Row[]; totalRemainingSen: number };
    expect(any.orders.map((o) => [o.docNo, o.status, o.remainingSen, o.movableSen, o.keepSen])).toEqual([
      [OLD, 'CANCELLED', 70_000, 70_000, 0], [OLD2, 'CANCELLED', 30_000, 30_000, 0], [LIVE, 'CONFIRMED', 100_000, 25_000, 75_000],
    ]);
    expect(any.totalRemainingSen).toBe(200_000);
    const mine = await (await app.request('/mfg-sales-orders/with-money?phone=0777')).json() as { orders: Row[] };
    expect(mine.orders.map((o) => o.docNo)).toEqual([LIVE]);
    /* A live order the new order may draw on is listed with what it may give; one at its floor is not. */
    const named = await (await app.request(`/mfg-sales-orders/${NEW}/convert-sources?also=${LIVE}`)).json() as { sources: Row[] };
    expect(named.sources.find((x) => x.docNo === LIVE)).toMatchObject({ movableSen: 25_000, keepSen: 75_000, cancelledOn: null, status: 'CONFIRMED' });
    expect((await convert(app, NEW, LIVE, 25_000)).status).toBe(201);
    const atFloor = await (await app.request(`/mfg-sales-orders/${NEW}/convert-sources?also=${LIVE}`)).json() as { sources: Row[] };
    expect(atFloor.sources.some((x) => x.docNo === LIVE)).toBe(false);
  });
});
