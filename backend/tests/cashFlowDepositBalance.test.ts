/* Customer receipts on the Cash Flow: Deposit (订金) and Balance (尾款), the rule
   the owner agreed on 2026-11-05:
     • the payment that brings an order's paid total up to its order total is the
       Balance; every payment before it is a Deposit; an order not yet fully paid
       has only Deposits;
     • all of an order's payments count, whatever their month;
     • under CASH IN: Deposit (Transfer / cash, Card - in the bank, Card - merchant
       matched, Card - not matched yet), the same four under Balance, then (-) Refund,
       then Other receipts that are not order payments. */

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp';
import { paymentKinds } from '../src/acc/order-payment-kind';

const pay = (id: string, doc: string, sen: number, paidAt: string, createdAt: string | null = null) =>
  ({ id, so_doc_no: doc, amount_sen: sen, paid_at: paidAt, created_at: createdAt });

describe('paymentKinds — Deposit or Balance', () => {
  test('the payment that completes the order is the Balance, every earlier one a Deposit, across months', () => {
    const k = paymentKinds({
      orders: [{ doc_no: 'SO-1', local_total_sen: 100000 }],
      /* Keyed out of order: the rule reads them in the order they were paid. */
      payments: [pay('p3', 'SO-1', 50000, '2026-10-02'), pay('p1', 'SO-1', 30000, '2026-09-03'), pay('p2', 'SO-1', 20000, '2026-09-20')],
    });
    expect(Object.fromEntries(k)).toEqual({ p1: 'DEP', p2: 'DEP', p3: 'BAL' });
  });

  test('an order not yet fully paid has only Deposits; a payment after it is paid in full is Balance too', () => {
    const k = paymentKinds({
      orders: [{ doc_no: 'SO-1', local_total_sen: 100000 }, { doc_no: 'SO-2', local_total_sen: 50000 }],
      payments: [
        pay('a1', 'SO-1', 30000, '2026-09-03'), pay('a2', 'SO-1', 60000, '2026-09-04'),
        pay('b1', 'SO-2', 50000, '2026-09-05'), pay('b2', 'SO-2', 5000, '2026-09-06'),
      ],
    });
    expect(Object.fromEntries(k)).toEqual({ a1: 'DEP', a2: 'DEP', b1: 'BAL', b2: 'BAL' });
  });

  test('the same day: the one keyed first came first; money that left the order counts against it', () => {
    const k = paymentKinds({
      orders: [{ doc_no: 'SO-1', local_total_sen: 100000 }],
      payments: [
        pay('x2', 'SO-1', 70000, '2026-09-03', '2026-09-03T05:00:00Z'),
        pay('x1', 'SO-1', 60000, '2026-09-03', '2026-09-03T02:00:00Z'),
        /* 30.00 converted out first … */
        pay('m', 'SO-1', -30000, '2026-09-02'),
      ],
    });
    /* … so 600 + 700 − 300 reaches 1,000 only with x2. */
    expect(Object.fromEntries(k)).toEqual({ m: 'DEP', x1: 'DEP', x2: 'BAL' });
  });

  test('an order with no total has nothing to complete: Deposits', () => {
    expect(paymentKinds({ orders: [{ doc_no: 'SO-1', local_total_sen: 0 }], payments: [pay('p', 'SO-1', 100, '2026-09-01')] }).get('p')).toBe('DEP');
  });
});

/* The report, through the real handler on a fake PostgREST. */
const CO = 2;
let lineId = 0;
const gl = (jeNo: string, date: string, source: string, doc: string | null, code: string, name: string, dr: number, cr: number): Row => ({
  line_id: ++lineId, company_id: CO, je_no: jeNo, entry_date: date, source_type: source, source_doc_no: doc,
  account_code: code, account_name: name, debit_sen: dr, credit_sen: cr, party_type: null, party_name: null, notes: null,
  posted: true, reversed: false,
});
const acct = (code: string, name: string, money: boolean, type: string, section: string): Row =>
  ({ company_id: CO, account_code: code, account_name: name, acc_money: money, is_active: true, account_type: type, section });
const BANK = '310-0010';
const PBB = '326-0010';
const AR = '300-0000';
const into = (je: string, date: string, source: string, doc: string, code: string, sen: number): Row[] => [
  gl(je, date, source, doc, code, 'MONEY', sen, 0),
  gl(je, date, source, doc, AR, 'ACCOUNT RECEIVEABLE', 0, sen),
];

type More = { gl?: Row[]; orders?: Row[]; payments?: Row[] };
const world = (more: More = {}) => fakeSb({
  accounts: [
    acct(BANK, 'CASH AT BANK - MAYBANK', true, 'ASSET', 'CURRENT ASSETS'),
    acct(PBB, 'CARD MACHINE CLEARING - PBB', false, 'ASSET', 'CURRENT ASSETS'),
    acct(AR, 'ACCOUNT RECEIVEABLE', false, 'ASSET', 'CURRENT ASSETS'),
  ],
  acc_account_roles: [],
  v_gl_entries: [
    /* SO-1 (1,000): a 300 transfer and a 200 card swipe in September, the 500 balance by transfer in October. */
    ...into('JE-1', '2026-09-03', 'SOPAY', 'p1', BANK, 30000),
    ...into('JE-2', '2026-09-20', 'SOPAY', 'p2', PBB, 20000),
    ...into('JE-3', '2026-10-02', 'SOPAY', 'p3', BANK, 50000),
    /* SO-2 (400): paid in full by one card swipe in October. */
    ...into('JE-4', '2026-10-05', 'SOPAY', 'q1', PBB, 40000),
    /* A sales-invoice payment: not an order payment. */
    ...into('JE-5', '2026-10-08', 'SIPAY', 'si-pay-1', BANK, 7000),
    /* A refund to a customer out of the bank. */
    gl('JE-6', '2026-10-10', 'PV', 'PV-R1', AR, 'ACCOUNT RECEIVEABLE', 9000, 0),
    gl('JE-6', '2026-10-10', 'PV', 'PV-R1', BANK, 'CASH AT BANK - MAYBANK', 0, 9000),
    ...(more.gl ?? []),
  ],
  mfg_sales_orders: [{ company_id: CO, doc_no: 'SO-1', local_total_sen: 100000 }, { company_id: CO, doc_no: 'SO-2', local_total_sen: 40000 }, ...(more.orders ?? [])],
  mfg_sales_order_payments: [
    { company_id: CO, ...pay('p1', 'SO-1', 30000, '2026-09-03') },
    { company_id: CO, ...pay('p2', 'SO-1', 20000, '2026-09-20') },
    { company_id: CO, ...pay('p3', 'SO-1', 50000, '2026-10-02') },
    { company_id: CO, ...pay('q1', 'SO-2', 40000, '2026-10-05') },
    ...(more.payments ?? []),
  ],
  payment_vouchers: [], pv_allocations: [], purchase_invoices: [], ap_invoices: [], ap_invoice_lines: [],
  acc_settlement_matches: [], acc_settlement_rows: [], acc_settlement_batches: [], acc_settlement_receipts: [],
  acc_report_layouts: [],
  acc_acquirers: [{ company_id: CO, code: 'PBB', display_name: 'PBB', transit_account_code: PBB, is_active: true }],
});

function harness(more: More = {}) {
  const app = new Hono();
  const sb = world(more);
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: ['scm.payment_voucher.post'] } as never);
    await next();
  });
  app.get('/accounting/reports/receipts-payments', receiptsPaymentsReport as never);
  return app;
}
type Laid = { kind: string; key?: string; label: string; amountSen: number; children: Laid[] };
type Report = {
  layout: { tree: Laid[]; inSen: number; outSen: number }; totals: { openingTotalSen: number; closingTotalSen: number };
  autoCount: { sen: number; count: number; entries: unknown[] };
};
const get = async (qs: string, more: More = {}): Promise<Report> => {
  const res = await harness(more).request(`/accounting/reports/receipts-payments?${qs}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as Report;
};
/* Where the debtor control sits: its lines and sub-headings, as label → amount, nested. */
const shape = (n: Laid): unknown => (n.children.length === 0 ? [n.label, n.amountSen] : [n.label, n.amountSen, n.children.map(shape)]);
const debtorPlace = (r: Report): Laid => r.layout.tree[0]!.children.find((n) => n.label === 'CURRENT ASSETS')!;

describe('Cash Flow: Deposit and Balance under CASH IN', () => {
  test('September: only Deposits (SO-1 is not paid in full yet), by how the money came in', async () => {
    const r = await get('from=2026-09-01&to=2026-09-30');
    expect(debtorPlace(r).children.map(shape)).toEqual([
      ['Deposit', 50000, [['Transfer / cash', 30000], ['Card - not matched yet', 20000]]],
    ]);
  });

  test('October: SO-1\'s last payment and SO-2\'s only one are Balance; then (-) Refund and Other receipts, in that order', async () => {
    const r = await get('from=2026-10-01&to=2026-10-31');
    expect(debtorPlace(r).children.map(shape)).toEqual([
      ['Balance', 90000, [['Transfer / cash', 50000], ['Card - not matched yet', 40000]]],
      ['(-) Refund', -9000],
      ['Other receipts (not order payments)', 7000],
    ]);
    /* The refund is a negative receipt, so Cash In is net of it and nothing is paid out. */
    expect(r.layout.inSen).toBe(88000);
    expect(r.layout.outSen).toBe(0);
    expect(r.totals.openingTotalSen + r.layout.inSen - r.layout.outSen).toBe(r.totals.closingTotalSen);
  });

  test('September and October together: September\'s payments stay Deposits (the rule reads the whole order, not the period)', async () => {
    const r = await get('from=2026-09-01&to=2026-10-31');
    const [dep, bal] = debtorPlace(r).children;
    expect(shape(dep!)).toEqual(['Deposit', 50000, [['Transfer / cash', 30000], ['Card - not matched yet', 20000]]]);
    expect(shape(bal!)).toEqual(['Balance', 90000, [['Transfer / cash', 50000], ['Card - not matched yet', 40000]]]);
  });

  test('by debtor, the rows keep the party and are not split', async () => {
    const r = await get('from=2026-10-01&to=2026-10-31&party=1');
    const labels = JSON.stringify(debtorPlace(r));
    expect(labels).not.toContain('"Deposit"');
    expect(labels).not.toContain('"Balance"');
  });
});

/* Owner 2026-11-08: 可以帮我注明是从auto count带过来的吗？ Customers' money AutoCount recorded after
   the books started came over on its order as 'imported' and posts no journal, so the ledger the
   Cash Flow reads never has it. The report names it, in no total. */
describe('Cash Flow: AutoCount money after the books started, named in no total', () => {
  const opening = [
    gl('JE-0', '2026-08-31', 'OPENING', null, BANK, 'CASH AT BANK - MAYBANK', 100000, 0),
    gl('JE-0', '2026-08-31', 'OPENING', null, '190-0000', 'OPENING BALANCE CLEARING', 0, 100000),
  ];
  const imported = (id: string, doc: string, sen: number, paidAt: string): Row =>
    ({ company_id: CO, ...pay(id, doc, sen, paidAt), method: 'imported', note: 'DATE NOT OBSERVED' });
  const orders: Row[] = [
    { company_id: CO, doc_no: 'SO-A', local_total_sen: 500000, debtor_name: 'TAN AH KOW', status: 'CONFIRMED' },
    { company_id: CO, doc_no: 'SO-X', local_total_sen: 20000, debtor_name: 'GONE', status: 'CANCELLED' },
  ];
  const payments: Row[] = [
    imported('a1', 'SO-A', 300000, '2026-09-05'),
    /* Inside the opening balances: AutoCount's 31/08 position already holds it. */
    imported('a0', 'SO-A', 100000, '2026-08-30'),
    /* A cancelled order's. */
    imported('x1', 'SO-X', 20000, '2026-09-06'),
    /* October's, not September's. */
    imported('a2', 'SO-A', 50000, '2026-10-02'),
  ];

  test('September names its own: after the opening, on a live order; no total and no row moves', async () => {
    const plain = await get('from=2026-09-01&to=2026-09-30');
    const r = await get('from=2026-09-01&to=2026-09-30', { gl: opening, orders, payments });
    expect(r.autoCount).toEqual({
      sen: 300000, count: 1,
      entries: [{
        jeNo: '', entryDate: '2026-09-05', sourceType: 'AUTOCOUNT', sourceDocNo: 'SO-A', narration: 'DATE NOT OBSERVED',
        party: 'TAN AH KOW', side: 'R', rowKey: 'AUTOCOUNT', column: 'AUTOCOUNT', sen: 300000,
      }],
    });
    expect(r.layout.inSen).toBe(plain.layout.inSen);
    expect(debtorPlace(r).children.map(shape)).toEqual(debtorPlace(plain).children.map(shape));
  });

  test('a company with no opening journal names every one in the period', async () => {
    const r = await get('from=2026-08-01&to=2026-09-30', { orders, payments });
    expect(r.autoCount.sen).toBe(400000);
    expect(r.autoCount.count).toBe(2);
  });

  test('none from AutoCount: zero, and an empty list', async () => {
    expect((await get('from=2026-09-01&to=2026-09-30')).autoCount).toEqual({ sen: 0, count: 0, entries: [] });
  });
});
