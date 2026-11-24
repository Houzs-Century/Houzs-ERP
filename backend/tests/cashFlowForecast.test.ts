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
import { cashFlowForecastHandler, clearCashFlowForecastCache, forecastInputsGetHandler, forecastInputsPutHandler, type CashFlowForecastPayload, type ForecastInputsPayload } from '../src/scm/routes/accounting-cashflow-forecast';
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

function harness(perms: string[] = ['scm.payment_voucher.post'], inputs: Row[] = []) {
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
