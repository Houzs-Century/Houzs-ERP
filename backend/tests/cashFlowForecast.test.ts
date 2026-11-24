/* The Cash Flow's P&L forecast column (step 2 of the Hookka forecast port).
   Pinned: the door's key and its range rule; each month a Cash Flow report of
   its own on the saved tree, the forecast on the actual money's lines (a
   purchase under Purchases, a salary under Salary & related, the customers'
   money under the debtor control's Deposit and Settlement); the months after
   the current one as far as the money reaches; the receipts measured over the
   3 complete months before today against their order month, imported,
   converted and mirror rows left out, another company's never read; a
   supplier's term from its own record, the suppliers without one named; the
   entries say where each figure came from; one answer per minute. Real
   handler, fake PostgREST. Made-up suppliers and figures. */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { cashFlowForecastHandler, clearCashFlowForecastCache, forecastInputsGetHandler, forecastInputsPutHandler, tfGetHandler, tfPutHandler, type CashFlowForecastPayload, type ForecastInputsPayload, type TfPayload } from '../src/scm/routes/accounting-cashflow-forecast';
import type { LaidNode } from '../src/acc/report-layout';

const CO = 1;
const acc = (code: string, name: string, type: string, section: string, over: Row = {}): Row =>
  ({ company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, section, is_active: true, ...over });
const ACCOUNTS: Row[] = [
  acc('300-0000', 'ACCOUNT RECEIVEABLE', 'ASSET', 'CURRENT ASSETS'),
  acc('410-0010', 'ACCRUAL - SALARIES', 'LIABILITY', 'CURRENT LIABILITIES'),
  acc('500-0003', 'SALES OF SOFA', 'INCOME', 'SALES'),
  acc('601-0003', 'PURCHASE OF SOFA', 'EXPENSE', 'COST OF GOODS SOLD'),
  acc('601-0001', 'PURCHASES OF BEDDING', 'EXPENSE', 'COST OF GOODS SOLD'),
  acc('900-S100', 'STAFF SALARIES & OVERTIME', 'EXPENSE', 'EXPENSES'),
  acc('900-R001', 'RENTAL', 'EXPENSE', 'EXPENSES'),
  acc('202-1000', 'EQUIPMENT (OFFICE)', 'ASSET', 'FIXED ASSETS'),
  acc('202-1005', 'ACCUM. DEPRN. - EQUIPMENT (OFFICE)', 'ASSET', 'FIXED ASSETS'),
  acc('460-0001', 'LOAN - SAMPLE BANK', 'LIABILITY', 'LONG TERM LIABILITIES'),
  acc('460-0009', 'TRADE FINANCE - SAMPLE BANK', 'LIABILITY', 'CURRENT LIABILITIES'),
];
const RP_TREE = { version: 1, blocks: { accounts: [
  { kind: 'category', id: 'cf:in', label: 'CASH IN', flow: 'in', totalLabel: 'TOTAL CASH IN', children: [
    { kind: 'category', id: 'cf:in:deposit', label: 'DEPOSIT RECEIVED', children: [{ kind: 'account', code: '300-0000', flow: 'in' }] },
  ] },
  { kind: 'category', id: 'cf:ops', label: 'OPERATIONS OUTFLOWS', flow: 'out', totalLabel: 'TOTAL OPERATIONS OUTFLOWS', children: [
    { kind: 'category', id: 'cf:ops:purchases', label: 'PURCHASES', children: [{ kind: 'account', code: '601-0003', flow: 'out' }, { kind: 'account', code: '601-0001', flow: 'out' }] },
    { kind: 'category', id: 'cf:ops:salary', label: 'SALARY & RELATED', children: [{ kind: 'account', code: '410-0010', flow: 'out' }, { kind: 'account', code: '900-S100', flow: 'out' }] },
    { kind: 'category', id: 'cf:ops:rental', label: 'RENTAL', children: [{ kind: 'account', code: '900-R001', flow: 'out' }] },
  ] },
  { kind: 'category', id: 'cf:funding', label: 'FUNDING IN / (OUT)', flow: 'in', totalLabel: 'TOTAL FUNDING', children: [
    { kind: 'category', id: 'cf:funding:capex', label: 'CAPITAL EXPENDITURE (CAPEX)', children: [{ kind: 'account', code: '202-1000', flow: 'net' }, { kind: 'account', code: '202-1005', flow: 'net' }] },
    { kind: 'category', id: 'cf:funding:loan', label: 'LOAN & HP DRAWDOWN', children: [{ kind: 'account', code: '460-0001', flow: 'in' }] },
    { kind: 'category', id: 'cf:funding:loan-out', label: 'LOAN & HP REPAYMENT', children: [{ kind: 'account', code: '460-0001', flow: 'out' }] },
    { kind: 'category', id: 'cf:funding:tf', label: 'TRADE FINANCE', children: [{ kind: 'account', code: '460-0009', flow: 'net' }] },
  ] },
] } };
const PNL_TREE = { version: 1, blocks: { expenses: [
  { kind: 'category', id: 'pl:general', label: 'Administrative expense', children: [
    { kind: 'category', id: 'pl:general:salary', label: 'Salary & related', children: [{ kind: 'account', code: '900-S100' }] },
    { kind: 'category', id: 'pl:general:office', label: 'Office & admin', children: [{ kind: 'account', code: '900-R001' }] },
  ] },
] } };
const SUPPLIERS: Row[] = [
  { id: 'sup-a', company_id: CO, code: '400-A001', name: 'Alpha Trading', status: 'ACTIVE', payment_terms: 'NET 60' },
  { id: 'sup-b', company_id: CO, code: '400-B001', name: 'Beta Supplies', status: 'ACTIVE', payment_terms: null },
  { id: 'sup-c', company_id: CO, code: '400-C001', name: 'Cedar Works', status: 'ACTIVE', payment_terms: 'COD' },
];
const gl = (je: string, date: string, code: string, dr: number, cr: number, over: Row = {}): Row => ({
  company_id: CO, line_id: `${je}:${code}`, je_no: je, entry_date: date, source_type: 'PI', account_code: code, debit_sen: dr, credit_sen: cr,
  party_type: null, party_code: null, posted: true, reversed: false, reversed_by_je: null, ...over,
});
const bill = (je: string, date: string, code: string, supplier: string, sen: number): Row[] => [
  gl(je, date, code, sen, 0), gl(je, date, '400-0000', 0, sen, { party_type: 'SUPPLIER', party_code: supplier }),
];
/* Bedding is billed by Cedar (COD) and Beta (no term), equally, in the window; a November bill is outside it. */
const LEDGER: Row[] = [
  ...bill('PI-1', '2026-09-10', '601-0001', '400-C001', 300_000),
  ...bill('PI-2', '2026-10-05', '601-0001', '400-B001', 300_000),
  ...bill('PI-3', '2026-11-02', '601-0001', '400-A001', 900_000),
];
const FORECAST: Row[] = [
  { company_id: CO, month: '2026-11', lines: { '500-0003': { amtSen: 10_000_000 }, '601-0003': { bp: 5500 }, '900-S100': { amtSen: 2_000_000 }, '900-R001': { amtSen: 500_000 } },
    suppliers: { '601-0003': { 'sup-a': { amtSen: 3_000_000 }, 'sup-b': { amtSen: 1_000_000 } } } },
  { company_id: CO, month: '2026-12', lines: { '500-0003': { amtSen: 8_000_000 }, '601-0001': { amtSen: 400_000 } }, suppliers: {} },
  { company_id: 2, month: '2026-11', lines: { '500-0003': { amtSen: 99_900_000 } }, suppliers: {} },
];
/* The measured receipts: deposits in the order month, settlements a month after; what is not customers' money coming in is left out. */
const ORDERS: Row[] = [
  { company_id: CO, doc_no: 'SO-1', so_date: '2026-08-12', local_total_sen: 100_000 },
  { company_id: CO, doc_no: 'SO-2', so_date: '2026-09-03', local_total_sen: 100_000 },
  { company_id: 2, doc_no: 'SO-X', so_date: '2026-09-01', local_total_sen: 900_000 },
];
const pay = (id: string, doc: string, paidAt: string, sen: number, over: Row = {}): Row =>
  ({ id, company_id: CO, so_doc_no: doc, paid_at: paidAt, amount_sen: sen, method: 'transfer', mirror_of_payment_id: null, created_at: `${paidAt}T03:00:00Z`, ...over });
const PAYMENTS: Row[] = [
  pay('p1', 'SO-1', '2026-08-12', 60_000),                                  // deposit, the order month
  pay('p2', 'SO-1', '2026-09-20', 40_000),                                  // settlement, a month after
  pay('p3', 'SO-2', '2026-09-03', 60_000, { method: 'merchant' }),          // deposit, the order month
  pay('p4', 'SO-2', '2026-10-15', 40_000),                                  // settlement, a month after
  pay('p5', 'SO-2', '2026-09-04', 500_000, { method: 'imported' }),         // carried over from AutoCount
  pay('p6', 'SO-2', '2026-09-05', 500_000, { method: 'converted' }),        // moved in from another order
  pay('p7', 'SO-1', '2026-09-06', 500_000, { mirror_of_payment_id: 'p0' }), // a mirror row
  pay('p8', 'SO-X', '2026-09-01', 900_000, { company_id: 2 }),              // another company's
];

function harness(perms: string[] = ['scm.payment_voucher.post'], inputs: Row[] = [], extra: Record<string, Row[]> = {}) {
  const sb = fakeSb({
    accounts: ACCOUNTS.map((r) => ({ ...r })),
    acc_item_group_accounts: [{ company_id: CO, group_code: 'SOFA', sales_account: '500-0003', purchase_account: '601-0003' }],
    acc_forecast_pnl: FORECAST.map((r) => ({ ...r })),
    acc_report_layouts: [
      { report: 'rp', tree: RP_TREE, updated_at: null, updated_by: 'T' },
      { report: 'pnl', tree: PNL_TREE, updated_at: null, updated_by: 'T' },
    ],
    acc_account_roles: [],
    suppliers: SUPPLIERS.map((r) => ({ ...r })),
    v_gl_entries: LEDGER.map((r) => ({ ...r })),
    mfg_sales_orders: ORDERS.map((r) => ({ ...r })),
    mfg_sales_order_payments: PAYMENTS.map((r) => ({ ...r })),
    acc_forecast_inputs: inputs.map((r) => ({ ...r })),
    ...extra,
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: 'HOUZS', name: 'Houzs' }] as never);
    await next();
  });
  app.get('/accounting/reports/cash-flow-forecast', cashFlowForecastHandler as never);
  app.get('/accounting/reports/cash-flow-forecast/inputs', forecastInputsGetHandler as never);
  app.put('/accounting/reports/cash-flow-forecast/inputs', forecastInputsPutHandler as never);
  app.get('/accounting/reports/cash-flow-forecast/tf', tfGetHandler as never);
  app.put('/accounting/reports/cash-flow-forecast/tf', tfPutHandler as never);
  return { app, sb };
}
const get = async (app: Hono, q: string): Promise<CashFlowForecastPayload & { cached?: boolean }> => {
  const res = await app.request(`/accounting/reports/cash-flow-forecast?${q}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as CashFlowForecastPayload & { cached?: boolean };
};
/** A tree as "id = amount" lines, depth-first. */
const flat = (nodes: LaidNode[]): string[] => nodes.flatMap((n) => [`${n.id} = ${n.amountSen}`, ...flat(n.children)]);

beforeEach(() => { clearCashFlowForecastCache(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-24T04:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('GET /accounting/reports/cash-flow-forecast', () => {
  test("the statements' key; a range of months, from on or before to", async () => {
    expect((await harness(['scm.payment_voucher.write']).app.request('/accounting/reports/cash-flow-forecast?from=2026-11&to=2026-11')).status).toBe(403);
    const { app } = harness();
    for (const q of ['from=2026-11-01&to=2026-11-30', 'from=2026-12&to=2026-11', 'from=2023-01&to=2026-11', 'to=2026-11']) {
      expect((await app.request(`/accounting/reports/cash-flow-forecast?${q}`)).status, q).toBe(400);
    }
  });

  test('each month a Cash Flow report on the saved tree: the forecast on the actual money\'s lines; the later months as far as the money reaches', async () => {
    const { app } = harness();
    const b = await get(app, 'from=2026-10&to=2026-11');
    expect(b.currentMonth).toBe('2026-11');
    expect(b.months.map((m) => [m.month, m.future])).toEqual([['2026-10', false], ['2026-11', false], ['2026-12', true], ['2027-01', true]]);
    const nov = b.months[1]!.report;
    expect(nov.layout.stored).toBe(true);
    /* November: sales 100,000 as 60% deposit now and 40% settlement next month; Beta (no term) and the
       salaries next month; Alpha (NET 60) in January; the rent now. */
    expect(flat(nov.layout.tree)).toEqual([
      'cf:in = 6000000', 'cf:in:deposit = 6000000', 'in:grp:300-0000:DEP = 6000000', 'in:acc:300-0000:DEP:FC = 6000000',
      'cf:ops = 500000', 'cf:ops:rental = 500000', 'out:acc:900-R001 = 500000',
    ]);
    expect(nov.totals).toMatchObject({ receiptsTotalSen: 6_000_000, paymentsTotalSen: 500_000, closingTotalSen: 5_500_000 });
    expect(nov.columns).toEqual([{ code: 'FORECAST', name: 'P&L forecast' }]);
    const dec = b.months[2]!.report;
    expect(flat(dec.layout.tree)).toEqual([
      'cf:in = 8800000', 'cf:in:deposit = 8800000',
      'in:grp:300-0000:DEP = 4800000', 'in:acc:300-0000:DEP:FC = 4800000',
      'in:grp:300-0000:BAL = 4000000', 'in:acc:300-0000:BAL:FC = 4000000',
      /* December's bedding (RM 4,000 keyed whole) by its recent suppliers: half COD now, half (no term) in January; Beta's November share; the salaries. */
      'cf:ops = 3200000', 'cf:ops:purchases = 1200000', 'out:acc:601-0003 = 1000000', 'out:acc:601-0001 = 200000',
      'cf:ops:salary = 2000000', 'out:acc:900-S100 = 2000000',
    ]);
    const jan = b.months[3]!.report;
    expect(flat(jan.layout.tree)).toEqual([
      'cf:in = 3200000', 'cf:in:deposit = 3200000', 'in:grp:300-0000:BAL = 3200000', 'in:acc:300-0000:BAL:FC = 3200000',
      'cf:ops = 3200000', 'cf:ops:purchases = 3200000', 'out:acc:601-0003 = 3000000', 'out:acc:601-0001 = 200000',
    ]);
    /* The entries say where each figure came from. */
    expect(jan.entries.filter((e) => e.rowKey === '601-0003')).toEqual([expect.objectContaining({
      sourceType: 'FORECAST', sourceDocNo: '2026-11', party: 'Alpha Trading', side: 'P', column: 'FORECAST', sen: 3_000_000,
      narration: 'Nov 2026 Forecast P&L · the supplier pays 2 months later',
    })]);
    /* October has no forecast month: an empty column. */
    expect(b.months[0]!.report.layout.tree).toEqual([]);
  });

  test("the measured receipts and the suppliers without a term are said; another company's are never read", async () => {
    const { app } = harness();
    const b = await get(app, 'from=2026-11&to=2026-11');
    expect(b.measured).toEqual({ from: '2026-08-01', to: '2026-10-31' });
    expect(b.receiptMix).toEqual([{ kind: 'DEP', months: 0, pct: 60 }, { kind: 'BAL', months: 1, pct: 40 }]);
    expect(b.flagged).toEqual([{ id: 'sup-b', code: '400-B001', name: 'Beta Supplies' }]);
    expect(b.nonCash).toEqual([]);
    /* Company 2's RM 999,000 of November sales reached nothing. */
    expect(b.months[0]!.report.totals.receiptsTotalSen).toBe(6_000_000);
  });

  test('a range ending before this month shows no later month; one answer per minute', async () => {
    const { app } = harness();
    const past = await get(app, 'from=2026-09&to=2026-10');
    expect(past.months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    expect(past.docs).toBeNull();
    expect(past.cached).toBeUndefined();
    expect((await get(app, 'from=2026-09&to=2026-10')).cached).toBe(true);
  });
});

/* Step 3 of the Hookka forecast port (2026-11-24): the Capex & financing
   table. Pinned: the accounts on offer are the funding block's, trade finance
   and accumulated depreciation aside; the table shows twelve months from this
   one; a save takes the vouchers' write key, replaces the company's whole
   table, refuses an account the layout does not offer, never touches another
   company's rows and is seen by the forecast at once; a keyed amount sits in
   the forecast on its own account in its own month, a past month too, and
   carries the later months as far as it reaches. Made-up figures. */
describe('the Capex & financing table', () => {
  const W = ['scm.payment_voucher.post', 'scm.payment_voucher.write'];
  const row = (company: number, month: string, code: string, sen: number): Row => ({ company_id: company, month, account_code: code, amount_sen: sen, updated_at: '2026-11-20T00:00:00Z', updated_by: 'T' });
  const put = (app: Hono, months: unknown) => app.request('/accounting/reports/cash-flow-forecast/inputs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ months }) });

  test('reading: the offered accounts grouped as the layout places them, twelve months from this one, the stored amounts, what is left to clear', async () => {
    const { app } = harness(undefined, [row(CO, '2026-12', '460-0001', 50_000_000), row(CO, '2027-02', '460-0009', -100), row(2, '2026-12', '202-1000', -1)]);
    const res = await app.request('/accounting/reports/cash-flow-forecast/inputs');
    expect(res.status).toBe(200);
    const b = (await res.json()) as ForecastInputsPayload;
    expect(b.currentMonth).toBe('2026-11');
    expect(b.shown).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08', '2027-09', '2027-10']);
    expect(b.accounts.map((a) => [a.code, a.group.label])).toEqual([
      ['202-1000', 'CAPITAL EXPENDITURE (CAPEX)'],
      ['460-0001', 'LOAN & HP DRAWDOWN / LOAN & HP REPAYMENT'],
    ]);
    /* Company 2's row is never read. */
    expect(b.months).toEqual({ '2026-12': { '460-0001': 50_000_000 }, '2027-02': { '460-0009': -100 } });
    expect(b.notOffered).toEqual([{ code: '460-0009', name: 'TRADE FINANCE - SAMPLE BANK' }]);
  });

  test('saving: the write key; the whole table replaced; an account not offered refused by name; another company untouched; the forecast sees it at once', async () => {
    expect((await put(harness().app, {})).status).toBe(403);
    const { app, sb } = harness(W, [row(CO, '2026-12', '460-0001', 50_000_000), row(CO, '2026-10', '202-1000', -300_000), row(2, '2026-12', '202-1000', -1)]);
    /* Read the forecast once, so the minute's memory holds it. */
    const before = await get(app, 'from=2026-10&to=2026-11');
    expect(before.months.find((m) => m.month === '2026-12')!.report.layout.tree.some((n) => n.id === 'cf:funding')).toBe(true);
    const bad = await put(app, { '2026-12': { '460-0009': -100 } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'bad_cell', cell: '2026-12 460-0009' });
    /* December's drawdown cleared, a January repayment and a February purchase of equipment keyed; October kept. */
    const ok = await put(app, { '2026-10': { '202-1000': -300_000 }, '2027-01': { '460-0001': -1_500_000 }, '2027-02': { '202-1000': -2_000_000, '460-0001': 0 } });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const rows = (sb.tables.acc_forecast_inputs as Row[]).map((r) => [r.company_id, r.month, r.account_code, r.amount_sen, r.updated_by]).sort();
    expect(rows).toEqual([
      [1, '2026-10', '202-1000', -300_000, 'Chew'],
      [1, '2027-01', '460-0001', -1_500_000, 'Chew'],
      [1, '2027-02', '202-1000', -2_000_000, 'Chew'],
      [2, '2026-12', '202-1000', -1, 'T'],
    ]);
    const after = await get(app, 'from=2026-10&to=2026-11');
    expect(after.cached).toBeUndefined();
    expect(after.months.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    /* A past month keeps what was keyed for it; the repayment sits on the loan's Out line, the capex on its Net line. */
    expect(flat(after.months[0]!.report.layout.tree)).toEqual(['cf:funding = -300000', 'cf:funding:capex = -300000', 'net:acc:202-1000 = -300000']);
    /* Under the funding block (an In side), money out prints negative, as the actual report prints it. */
    const jan = flat(after.months[3]!.report.layout.tree);
    expect(jan.slice(jan.indexOf('cf:funding = -1500000'))).toEqual(['cf:funding = -1500000', 'cf:funding:loan-out = -1500000', 'out:acc:460-0001 = -1500000']);
    expect(after.months[4]!.report.entries.find((e) => e.rowKey === '202-1000')).toMatchObject({ sourceType: 'FORECAST_INPUT', party: 'Keyed on Cash Flow (Capex & financing)', side: 'P', sen: 2_000_000 });
  });
});

/* Step 4 of the Hookka forecast port (2026-11-24): the Orders & bills column.
   Pinned: the current month as at its 1st — an order's balance with what was
   paid on it since added back, an order placed since then left out, one whose
   delivery date had passed on its own row; the bills the books owe, a
   supplier's payment that names no bill paying its oldest, each bill paid on
   its plan, its due date or its supplier's term on the accounts it was bought
   on, a past-due one and an opening balance on the creditor control's own
   row; the later months from today's orders and bills; an order with no
   delivery date in no month, by the year ordered; the Forecast P&L's rent
   less the rent bill already counted; another company's orders never read.
   Made-up names and figures. */
describe('the Orders & bills column', () => {
  const order = (doc: string, soDate: string, balance: number, delivery: string | null, over: Row = {}): Row => ({
    company_id: CO, doc_no: doc, so_date: soDate, local_total_sen: balance, balance_sen: balance, status: 'IN_PRODUCTION',
    debtor_name: `Customer ${doc}`, customer_delivery_date: delivery, amended_delivery_date: null, ...over,
  });
  const api = (doc: string, date: string, sen: number): Row[] =>
    bill(doc, date, '900-R001', '400-D001', sen).map((r) => ({ ...r, source_type: 'API', source_doc_no: doc }));
  const extra = (): Record<string, Row[]> => ({
    suppliers: [...SUPPLIERS, { id: 'sup-d', company_id: CO, code: '400-D001', name: 'Delta Property', status: 'ACTIVE', payment_terms: 'NET 30' }].map((r) => ({ ...r })),
    mfg_sales_orders: [
      ...ORDERS,
      order('SO-10', '2026-10-05', 200_000, '2026-11-20'),
      order('SO-11', '2026-09-01', 300_000, '2026-10-15', { status: 'DELIVERED' }),
      order('SO-12', '2026-11-05', 400_000, '2026-12-10'),
      order('SO-13', '2026-06-01', 100_000, null),
      order('SO-14', '2025-03-01', 70_000, null),
      order('SO-15', '2026-10-01', 500_000, '2028-01-01'),
      order('SO-16', '2026-10-01', 999, '2026-11-02', { status: 'CANCELLED' }),
      order('SO-17', '2026-10-10', 0, '2026-11-03'),
      order('SO-18', '2026-10-10', 50_000, '2026-11-01', { amended_delivery_date: '2026-12-01' }),
      order('SO-Y', '2026-10-01', 777_000, '2026-11-15', { company_id: 2 }),
    ].map((r) => ({ ...r })),
    mfg_sales_order_payments: [...PAYMENTS, pay('p9', 'SO-10', '2026-11-10', 50_000), pay('p10', 'SO-17', '2026-11-03', 80_000)].map((r) => ({ ...r })),
    v_gl_entries: [
      ...LEDGER.map((r) => ({ ...r, source_doc_no: r.je_no })),
      /* Cedar paid in October by a voucher that names no bill: its oldest bill is the one paid. */
      gl('PV-1', '2026-10-20', '400-0000', 300_000, 0, { source_type: 'PV', source_doc_no: 'PV-1', party_type: 'SUPPLIER', party_code: '400-C001' }),
      gl('PV-1', '2026-10-20', '310-0001', 0, 300_000, { source_type: 'PV', source_doc_no: 'PV-1' }),
      /* Beta's balance brought over when the books began. */
      gl('OB-1', '2026-08-31', '400-0000', 0, 50_000, { source_type: 'OB', source_doc_no: null, party_type: 'SUPPLIER', party_code: '400-B001' }),
      /* Delta's rent: October's due on 5 November, November's on 5 December. */
      ...api('API-0', '2026-10-28', 200_000),
      ...api('API-1', '2026-11-10', 120_000),
    ],
    purchase_invoices: ['PI-1', 'PI-2', 'PI-3'].map((no) => ({ id: no.toLowerCase(), company_id: CO, invoice_number: no, due_date: null, exchange_rate: null, status: 'POSTED', total_sen: 1, paid_sen: 0, migrated_no_stock: false })),
    ap_invoices: [
      { id: 'api-0', company_id: CO, invoice_number: 'API-0', due_date: '2026-11-05' },
      { id: 'api-1', company_id: CO, invoice_number: 'API-1', due_date: '2026-12-05' },
    ],
    ap_invoice_lines: [
      { company_id: CO, invoice_id: 'api-0', debit_account_code: '900-R001', amount_sen: 200_000 },
      { company_id: CO, invoice_id: 'api-1', debit_account_code: '900-R001', amount_sen: 120_000 },
    ],
    payment_vouchers: [{ id: 'pv-1', company_id: CO, pv_number: 'PV-1', voucher_date: '2026-10-20' }],
    /* Alpha's November bill (NET 60) is planned for 15 December. */
    acc_bill_plans: [{ company_id: CO, bill_kind: 'PI', bill_id: 'pi-3', planned_on: '2026-12-15' }],
  });
  const rows = (r: { receipts: Array<{ key: string; name: string; totalSen: number }>; payments: Array<{ key: string; name: string; totalSen: number }> }) => ({
    in: r.receipts.map((x) => [x.key, x.name, x.totalSen]),
    out: r.payments.map((x) => [x.key, x.name, x.totalSen]),
  });

  test('the current month as at its 1st; the later months from today; what is in no month is said', async () => {
    const { app } = harness(undefined, [], extra());
    const b = await get(app, 'from=2026-09&to=2026-11');
    const docs = b.docs!;
    expect(docs.asAt).toBe('2026-11-01');
    expect(docs.months.map((m) => [m.month, m.future])).toEqual([['2026-11', false], ['2026-12', true]]);
    const nov = docs.months[0]!.report;
    expect(nov.columns).toEqual([{ code: 'FORECAST', name: 'Orders & bills' }]);
    expect(rows(nov)).toEqual({
      in: [
        ['300-0000:BAL:LATE', 'Past delivery date, not paid', 300_000],
        ['300-0000:BAL:ORD', 'Open orders (balance on delivery)', 330_000],
      ],
      out: [
        ['400-0000:LATE', 'Supplier bills past due', 50_000],
        ['601-0001', 'PURCHASES OF BEDDING', 300_000],
        ['900-R001', 'RENTAL', 500_000],
      ],
    });
    expect(nov.entries.filter((e) => e.rowKey === '900-R001').map((e) => [e.sourceType, e.sourceDocNo, e.party, e.sen, e.narration])).toEqual([
      ['FORECAST_BILL', 'API-0', 'Delta Property', 200_000, 'due 2026-11-05'],
      ['FORECAST', '2026-11', 'RENTAL', 300_000, 'Nov 2026 Forecast P&L · less the bills already counted'],
    ]);
    expect(nov.entries.find((e) => e.sourceDocNo === 'SO-10')).toMatchObject({ sourceType: 'FORECAST_ORDER', party: 'Customer SO-10', sen: 250_000, side: 'R', narration: 'delivery 2026-11-20 · balance on delivery' });
    const dec = docs.months[1]!.report;
    expect(rows(dec)).toEqual({
      in: [['300-0000:BAL:ORD', 'Open orders (balance on delivery)', 450_000]],
      out: [['601-0001', 'PURCHASES OF BEDDING', 900_000], ['900-R001', 'RENTAL', 120_000], ['900-S100', 'STAFF SALARIES & OVERTIME', 2_000_000]],
    });
    expect(dec.entries.find((e) => e.sourceDocNo === 'PI-3')).toMatchObject({ party: 'Alpha Trading', narration: 'planned for 2026-12-15' });
    expect(docs.undated).toEqual([{ year: '2025', orders: 1, sen: 70_000 }, { year: '2026', orders: 1, sen: 100_000 }]);
    expect(docs.beyond).toEqual({ orders: 1, orderSen: 500_000, bills: 0, billSen: 0 });
    expect(docs.flagged).toEqual(['Beta Supplies']);
  });

  /* Step 5 (2026-11-24): the trade-finance plan. The facility drew 1,000.00 when the books began, 2,000.00 in
     September and 500.00 in November; October's repayment of 1,500.00 paid the oldest first, its interest
     10.00 on the loan-interest account. Alpha is the supplier the facility pays. */
  const tfTables = (): Record<string, Row[]> => {
    const base = extra();
    const fac = (je: string, date: string, src: string, lines: Array<[string, number, number]>): Row[] =>
      lines.map(([code, dr, cr]) => gl(je, date, code, dr, cr, { source_type: src, source_doc_no: je }));
    return {
      ...base,
      accounts: [
        ...ACCOUNTS,
        acc('310-0060', 'CASH AT BANK - SAMPLE BANK (TRADE FINANCE)', 'ASSET', 'CURRENT ASSETS', { acc_money: true }),
        acc('900-L004', 'LOAN INTEREST', 'EXPENSE', 'EXPENSES'),
      ].map((r) => ({ ...r })),
      acc_forecast_pnl: FORECAST.map((r) => (r.month === '2026-11' && r.company_id === CO ? { ...r, lines: { ...(r.lines as object), '900-L004': { amtSen: 5_000 } } } : { ...r })),
      v_gl_entries: [
        ...(base.v_gl_entries ?? []),
        ...fac('OB-TF', '2026-08-31', 'OPENING', [['460-0009', 0, 100_000]]),
        ...fac('JV-TF1', '2026-09-14', 'MANUAL', [['310-0060', 200_000, 0], ['460-0009', 0, 200_000]]),
        ...fac('PV-TF1', '2026-10-20', 'PV', [['460-0009', 150_000, 0], ['900-L004', 1_000, 0], ['310-0060', 0, 151_000]]),
        ...fac('JV-TF2', '2026-11-05', 'MANUAL', [['310-0060', 50_000, 0], ['460-0009', 0, 50_000]]),
      ],
      acc_tf_plans: [{ company_id: CO, account_code: '460-0009', tenor_days: null, rate_bp: null, suppliers: ['sup-a'], off: {} }],
    };
  };

  test('the trade-finance plan: the owed draws repaid two months after them with the repayments’ rate, the chosen supplier’s dues drawn and repaid; both forecasts carry it', async () => {
    const { app } = harness(undefined, [], tfTables());
    const res = await app.request('/accounting/reports/cash-flow-forecast/tf');
    expect(res.status, await res.clone().text()).toBe(200);
    const t = (await res.json()) as TfPayload;
    expect(t.facilities).toHaveLength(1);
    const f = t.facilities[0]!;
    expect(f).toMatchObject({
      code: '460-0009', lender: 'SAMPLE BANK', tenorSet: null, rateSet: null, tenorDays: 60, rateBp: 67, defaultRateBp: 67,
      interest: { code: '900-L004', name: 'LOAN INTEREST' }, owedNowSen: 200_000, suppliers: ['sup-a'], off: {},
      open: [{ date: '2026-09-14', sen: 150_000 }, { date: '2026-11-05', sen: 50_000 }],
    });
    /* Every supplier's dues, the chosen one's drawn: Alpha's planned bill and its NET 60 figure; Beta's
       bill and opening balance (no term: a month after) and its figure; Delta's two rent bills. */
    expect(f.dues).toEqual({
      'sup-a': { '2026-12': { billSen: 900_000, forecastSen: 0 }, '2027-01': { billSen: 0, forecastSen: 3_000_000 } },
      'sup-b': { '2026-11': { billSen: 350_000, forecastSen: 0 }, '2026-12': { billSen: 0, forecastSen: 1_000_000 } },
      'sup-d': { '2026-11': { billSen: 200_000, forecastSen: 0 }, '2026-12': { billSen: 120_000, forecastSen: 0 } },
    });
    expect(f.schedule.slice(0, 5).map((m) => [m.ym, m.drawSen, m.repaySen, m.interestSen, m.owedSen])).toEqual([
      ['2026-11', 0, 150_000, 1_005, 50_000],
      ['2026-12', 900_000, 0, 0, 950_000],
      ['2027-01', 3_000_000, 50_000, 335, 3_900_000],
      ['2027-02', 0, 900_000, 6_030, 3_000_000],
      ['2027-03', 0, 3_000_000, 20_100, 0],
    ]);
    expect(t.suppliers.map((s) => s.name)).toEqual(['Alpha Trading', 'Beta Supplies', 'Cedar Works', 'Delta Property']);

    const b = await get(app, 'from=2026-09&to=2026-11');
    expect(b.tf).toEqual({
      facilities: [{ code: '460-0009', lender: 'SAMPLE BANK', tenorDays: 60, rateBp: 67, owedNowSen: 200_000, suppliers: ['Alpha Trading'] }],
      interestLeftOut: [{ code: '900-L004', name: 'LOAN INTEREST' }],
    });
    const nov = b.docs!.months[0]!.report;
    expect(nov.payments.filter((r) => ['460-0009', '900-L004'].includes(r.key)).map((r) => [r.key, r.totalSen])).toEqual([['460-0009', 150_000], ['900-L004', 1_005]]);
    expect(b.docs!.months.find((m) => m.month === '2026-12')!.report.receipts.find((r) => r.key === '460-0009:PLAN')).toMatchObject({ name: 'Drawdown — planned', totalSen: 900_000 });
    expect(b.docs!.months.map((m) => m.month)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    /* The P&L forecast carries the same plan; its own November interest line steps aside. */
    const fpNov = b.months.find((m) => m.month === '2026-11')!.report;
    expect(fpNov.payments.filter((r) => r.key === '900-L004').map((r) => r.totalSen)).toEqual([1_005]);
    expect(fpNov.entries.find((e) => e.rowKey === '460-0009')).toMatchObject({ sourceType: 'FORECAST_TF', party: 'SAMPLE BANK', narration: 'drawn 2026-09-14, repaid 2 months after' });
    expect(b.months.find((m) => m.month === '2027-03')!.report.payments.find((r) => r.key === '460-0009')?.totalSen).toBe(3_000_000);
  });

  test('saving the plan: the write key; a facility of the company only, its suppliers only; the tenor and rate within reason; unticked months kept for the chosen suppliers', async () => {
    const put = (app: Hono, facilities: unknown) => app.request('/accounting/reports/cash-flow-forecast/tf', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ facilities }) });
    expect((await put(harness(undefined, [], tfTables()).app, {})).status).toBe(403);
    const { app, sb } = harness(['scm.payment_voucher.post', 'scm.payment_voucher.write'], [], tfTables());
    const plan = { tenorDays: 90, rateBp: null, suppliers: ['sup-a', 'sup-b'], off: { '2027-01': ['sup-a', 'sup-x'], 'bad': ['sup-a'] } };
    for (const [facilities, message] of [
      [{ '460-0001': plan }, '460-0001: not a trade-finance account of this company.'],
      [{ '460-0009': { ...plan, suppliers: ['sup-a', 'sup-zz'] } }, '460-0009: supplier sup-zz is not one of this company\'s.'],
      [{ '460-0009': { ...plan, tenorDays: 0 } }, '460-0009: the tenor is a whole number of days, 1 to 400.'],
      [{ '460-0009': { ...plan, rateBp: 10_001 } }, '460-0009: the interest per draw is 0% to 100%.'],
    ] as const) {
      const r = await put(app, facilities);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ error: 'bad_plan', message });
    }
    const ok = await put(app, { '460-0009': plan });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((sb.tables.acc_tf_plans as Row[]).map((r) => [r.company_id, r.account_code, r.tenor_days, r.rate_bp, r.suppliers, r.off, r.updated_by])).toEqual([
      [CO, '460-0009', 90, null, ['sup-a', 'sup-b'], { '2027-01': ['sup-a'] }, 'Chew'],
    ]);
  });
});
