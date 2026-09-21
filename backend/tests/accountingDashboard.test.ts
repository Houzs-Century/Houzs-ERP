/* The Financial Dashboard (owner 2026-09-21). Pinned:
     • every ACTUAL figure equals the statement's own route for the same
       period, to the sen — the P&L's totals, the Cash Flow's in / out, the
       Performance P&L's groups, the balance sheet's totals — because the
       Dashboard answers from the same builders over a preloaded window;
     • staff cost is the P&L layout's Salary & related category, other
       expenses the rest; the forecast side reads the same category by code;
     • the forecast is the grid's own arithmetic per month, null where no
       month of the period carries a row; a future period carries no actuals;
     • the cost structure: Spend from the orders' cost per group, Purchase
       from the groups' purchase accounts, Closing stock from the engine by
       product category, Bedding = mattress + bedframe;
     • a period not finished today is partial; a booked month-end is not
       provisional, the open month is;
     • quarters add their months; the door refuses bad queries by sentence,
       answers 403 without the statements' key, and remembers a payload for
       a minute.
   Real handlers, fake PostgREST (fakeSb). */
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { buildDashboard, clearDashboardCache, dashboardHandler, parseDashboardQuery, type DashboardPayload } from '../src/scm/routes/accounting-dashboard';
import { balanceSheetReport, pnlReport } from '../src/scm/routes/accounting-reports';
import { receiptsPaymentsReport } from '../src/scm/routes/accounting-rp';
import { performanceReport } from '../src/scm/routes/accounting-performance';

const CO = 2;
const TODAY = '2026-09-21';

const acc = (code: string, name: string, type: string, section: string | null, over: Row = {}): Row =>
  ({ company_id: CO, account_code: code, account_name: name, account_type: type, parent_code: null, section, is_active: true, acc_money: false, ...over });
const ACCOUNTS: Row[] = [
  acc('100-0000', 'CAPITAL', 'EQUITY', 'CAPITAL'),
  acc('310-0010', 'BANK', 'ASSET', 'CURRENT ASSETS', { acc_money: true }),
  acc('320-0000', 'CASH', 'ASSET', 'CURRENT ASSETS', { acc_money: true }),
  acc('300-0000', 'AR', 'ASSET', 'CURRENT ASSETS'),
  acc('330-0000', 'STOCK', 'ASSET', 'CURRENT ASSETS'),
  acc('600-0000', 'STOCKS AT BEGINNING', 'EXPENSE', 'COST OF GOODS SOLD'),
  acc('620-0000', 'STOCKS AT END', 'EXPENSE', 'COST OF GOODS SOLD'),
  ...['CUSTOMER', 'DISPLAY', 'SERVICE'].flatMap((b, i) => [
    acc(`330-000${i + 1}`, `STOCK - ${b}`, 'ASSET', 'CURRENT ASSETS', { parent_code: '330-0000' }),
    acc(`600-000${i + 1}`, `STOCKS AT THE BEGINNING OF YEAR - ${b}`, 'EXPENSE', 'COST OF GOODS SOLD', { parent_code: '600-0000' }),
    acc(`620-000${i + 1}`, `STOCKS AT THE END OF YEAR - ${b}`, 'EXPENSE', 'COST OF GOODS SOLD', { parent_code: '620-0000' }),
  ]),
  acc('400-0000', 'AP', 'LIABILITY', 'CURRENT LIABILITIES'),
  acc('500-0003', 'SALES OF SOFA', 'INCOME', 'SALES'),
  acc('601-0003', 'PURCHASE OF SOFA', 'EXPENSE', 'COST OF GOODS SOLD'),
  acc('601-0001', 'PURCHASE OF BEDDING', 'EXPENSE', 'COST OF GOODS SOLD'),
  acc('590-0000', 'RENT RECEIVED', 'INCOME', 'OTHER INCOMES'),
  acc('900-S001', 'SALARY', 'EXPENSE', 'EXPENSES'),
  acc('900-A001', 'ADVERT', 'EXPENSE', 'EXPENSES'),
  acc('950-0000', 'TAXATION', 'EXPENSE', 'TAXATION'),
];
/* The owner's P&L tree, the part that matters here: Salary & related under Administrative expense (the seed's own ids). */
const PNL_LAYOUT = {
  version: 1,
  blocks: {
    expenses: [
      { kind: 'category', id: 'pl:general', label: 'Administrative expense', children: [
        { kind: 'category', id: 'pl:general:salary', label: 'Salary & related', children: [{ kind: 'account', code: '900-S001' }] },
        { kind: 'category', id: 'pl:general:office', label: 'Office & admin', children: [{ kind: 'account', code: '900-A001' }] },
      ] },
    ],
  },
};

let lineNo = 0;
let jeNo = 0;
const names = new Map(ACCOUNTS.map((a) => [String(a.account_code), { name: String(a.account_name), type: String(a.account_type) }]));
/** One journal: [code, dr, cr] lines on a date. */
const je = (date: string, source: string, lines: Array<[string, number, number]>): Row[] => {
  jeNo += 1;
  const no = `JE-${String(jeNo).padStart(3, '0')}`;
  return lines.map(([code, dr, cr]) => {
    lineNo += 1;
    return {
      line_id: `l-${String(lineNo).padStart(4, '0')}`, je_no: no, entry_date: date, source_type: source, source_doc_no: `${source}-${jeNo}`,
      company_id: CO, account_code: code, account_name: names.get(code)?.name ?? code, account_type: names.get(code)?.type ?? '',
      debit_sen: dr, credit_sen: cr, party_type: null, party_code: null, party_name: null, notes: null, posted: true, reversed: false, reversed_by_je: null,
    };
  });
};
const GL: Row[] = [
  ...je('2026-01-01', 'MANUAL', [['310-0010', 50_000, 0], ['100-0000', 0, 50_000]]),
  ...je('2026-08-15', 'SI', [['300-0000', 100_000, 0], ['500-0003', 0, 100_000]]),
  ...je('2026-08-15', 'SOPAY', [['310-0010', 100_000, 0], ['300-0000', 0, 100_000]]),
  ...je('2026-08-16', 'PI', [['601-0003', 60_000, 0], ['400-0000', 0, 60_000]]),
  ...je('2026-08-16', 'PI', [['601-0001', 8_000, 0], ['400-0000', 0, 8_000]]),
  ...je('2026-08-20', 'PV', [['900-S001', 20_000, 0], ['310-0010', 0, 20_000]]),
  ...je('2026-08-21', 'PV', [['900-A001', 5_000, 0], ['310-0010', 0, 5_000]]),
  ...je('2026-08-22', 'RCT', [['310-0010', 3_000, 0], ['590-0000', 0, 3_000]]),
  ...je('2026-08-25', 'PV', [['950-0000', 1_000, 0], ['310-0010', 0, 1_000]]),
  ...je('2026-09-10', 'SOPAY', [['310-0010', 50_000, 0], ['500-0003', 0, 50_000]]),
  ...je('2026-09-12', 'PV', [['900-A001', 2_000, 0], ['310-0010', 0, 2_000]]),
];
const MOVES: Row[] = [
  { company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 10_000, movement_date: '2026-08-10', created_at: '2026-08-10T02:00:00Z', item_code: 'SOFA-1', warehouse_id: null, source_doc_type: 'GRN', source_doc_no: 'GRN-1' },
  { company_id: CO, movement_type: 'IN', qty: 2, total_cost_sen: 4_000, movement_date: '2026-09-05', created_at: '2026-09-05T02:00:00Z', item_code: 'MAT-1', warehouse_id: null, source_doc_type: 'GRN', source_doc_no: 'GRN-2' },
];
let itemNo = 0;
const line = (docNo: string, group: string, code: string, totalSen: number, unitCostSen: number): Row => ({
  id: `item-${String(++itemNo).padStart(3, '0')}`, company_id: CO, doc_no: docNo, item_group: group, item_code: code,
  qty: 1, total_sen: totalSen, unit_cost_sen: unitCostSen, line_cost_sen: unitCostSen, cancelled: false,
});
const FORECAST: Row[] = [
  { company_id: CO, month: '2026-09', lines: { '500-0003': { amtSen: 120_000 }, '601-0003': { bp: 6000 }, '900-S001': { amtSen: 20_000 }, '900-A001': { bp: 500 } } },
  { company_id: CO, month: '2026-11', lines: { '500-0003': { amtSen: 150_000 }, '601-0003': { bp: 6000 } } },
];

function world(over: Record<string, Row[]> = {}) {
  lineNo = 0; jeNo = 0; itemNo = 0;
  return fakeSb({
    accounts: ACCOUNTS.map((r) => ({ ...r })),
    v_gl_entries: GL.map((r) => ({ ...r })),
    acc_report_layouts: [{ report: 'pnl', tree: PNL_LAYOUT, updated_at: null, updated_by: null }],
    inventory_movements: MOVES.map((r) => ({ ...r })),
    warehouses: [],
    acc_account_roles: [],
    journal_entries: [{ company_id: CO, source_type: 'STOCKADJ', source_doc_no: 'STOCKADJ-2-2026-08', reversed: false }],
    acc_forecast_pnl: FORECAST.map((r) => ({ ...r })),
    mfg_sales_orders: [
      { company_id: CO, doc_no: 'SO-1', so_date: '2026-08-02', status: 'CONFIRMED', delivery_fee_sen: null },
      { company_id: CO, doc_no: 'SO-2', so_date: '2026-08-20', status: 'DELIVERED', delivery_fee_sen: null },
      { company_id: CO, doc_no: 'SO-3', so_date: '2026-09-03', status: 'CONFIRMED', delivery_fee_sen: null },
    ],
    mfg_sales_order_items: [
      line('SO-1', 'sofa', 'SOFA-1', 300_000, 180_000),
      line('SO-2', 'mattress', 'MAT-1', 100_000, 60_000),
      line('SO-3', 'sofa', 'SOFA-1', 200_000, 120_000),
    ],
    acc_company_settings: [],
    acc_item_group_accounts: [
      { company_id: CO, group_code: 'SOFA', purchase_account: '601-0003' },
      { company_id: CO, group_code: 'MATTRESS', purchase_account: '601-0001' },
      { company_id: CO, group_code: 'BEDFRAME', purchase_account: '601-0001' },
    ],
    mfg_products: [
      { company_id: CO, code: 'SOFA-1', category: 'SOFA' },
      { company_id: CO, code: 'MAT-1', category: 'MATTRESS' },
    ],
    payment_vouchers: [], pv_allocations: [],
    ...over,
  });
}

function harness(perms: string[] = ['scm.payment_voucher.post'], over: Record<string, Row[]> = {}) {
  const sb = world(over);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'Chew', permissions_set: new Set(perms) } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990', name: '2990 Home' }] as never);
    await next();
  });
  app.get('/accounting/dashboard', dashboardHandler as never);
  app.get('/accounting/reports/pnl', pnlReport as never);
  app.get('/accounting/reports/balance-sheet', balanceSheetReport as never);
  app.get('/accounting/reports/receipts-payments', receiptsPaymentsReport as never);
  app.get('/accounting/reports/performance', performanceReport as never);
  return { app, sb };
}
const json = async <T,>(res: Response): Promise<T> => (await res.json()) as T;

beforeEach(() => clearDashboardCache());

describe('parseDashboardQuery', () => {
  test('defaults, limits and the range rule', () => {
    expect(parseDashboardQuery({})).toEqual({ ok: true, query: { granularity: 'month', periods: 12, from: null, to: null } });
    expect(parseDashboardQuery({ granularity: 'quarter' })).toMatchObject({ ok: true, query: { granularity: 'quarter', periods: 8 } });
    expect(parseDashboardQuery({ granularity: 'week' })).toMatchObject({ ok: false });
    expect(parseDashboardQuery({ periods: '0' })).toMatchObject({ ok: false });
    expect(parseDashboardQuery({ periods: '37' })).toMatchObject({ ok: false });
    expect(parseDashboardQuery({ from: '2026-01' })).toMatchObject({ ok: false });
    expect(parseDashboardQuery({ from: '2026-05', to: '2026-01' })).toMatchObject({ ok: false });
    expect(parseDashboardQuery({ from: '2020-01', to: '2026-01' })).toMatchObject({ ok: false });
    expect(parseDashboardQuery({ from: '2026-08', to: '2026-11', periods: '3' })).toEqual({ ok: true, query: { granularity: 'month', periods: 3, from: '2026-08', to: '2026-11' } });
  });
});

describe('buildDashboard — months', () => {
  const build = async () => {
    const { sb, app } = harness();
    const r = await buildDashboard(sb, CO, [CO], { granularity: 'month', periods: 2, from: null, to: null }, TODAY);
    if (!r.ok) throw new Error(r.reason);
    return { payload: r.payload, app };
  };

  test('the window is the last two months plus the forecast\'s later months; partial and provisional flags', async () => {
    const { payload } = await build();
    expect(payload.periods.map((p) => p.key)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(payload.periods.map((p) => p.partial)).toEqual([false, true, true, true]);
    expect(payload.periods.map((p) => p.stock.closingProvisional)).toEqual([false, true, true, true]);
    expect(payload.forecastMonths).toEqual(['2026-09', '2026-11']);
    expect(payload.window).toEqual({ from: '2026-08-01', to: '2026-11-30' });
    expect(payload.groups.costStructure.map((g) => g.key)).toEqual(['sofa', 'bedding', 'accessories', 'dining', 'others']);
  });

  test('August\'s actuals are the statements\' own figures — P&L, staff cost off the layout, Cash Flow, Performance, balance sheet', async () => {
    const { payload, app } = await build();
    const aug = payload.periods[0]!;
    const pnl = await json<{ totals: Record<string, number> }>(await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31'));
    expect(aug.actual).toEqual({
      salesSen: pnl.totals.tradingIncomeSen, costOfSalesSen: pnl.totals.costOfSalesSen, grossProfitSen: pnl.totals.grossProfitSen,
      otherIncomeSen: pnl.totals.otherIncomeSen, expensesSen: pnl.totals.expensesSen, staffCostSen: 20_000, otherExpensesSen: 5_000,
      profitBeforeTaxSen: pnl.totals.profitBeforeTaxSen, taxationSen: pnl.totals.taxationSen, netProfitSen: pnl.totals.netProfitSen,
    });
    /* And the figures themselves: purchases 68,000 + opening 0 − closing 10,000 = cost of sales 58,000. */
    expect(aug.actual).toMatchObject({ salesSen: 100_000, costOfSalesSen: 58_000, grossProfitSen: 42_000, otherIncomeSen: 3_000, expensesSen: 25_000, taxationSen: 1_000, netProfitSen: 19_000 });

    const rp = await json<{ totals: Record<string, number> }>(await app.request('/accounting/reports/receipts-payments?from=2026-08-01&to=2026-08-31'));
    expect(aug.cashFlow).toMatchObject({ inSen: rp.totals.receiptsTotalSen, outSen: rp.totals.paymentsTotalSen, openingSen: rp.totals.openingTotalSen, closingSen: rp.totals.closingTotalSen });
    expect(aug.cashFlow).toMatchObject({ inSen: 103_000, outSen: 26_000, netSen: 77_000, openingSen: 50_000, closingSen: 127_000 });
    expect(Array.isArray(aug.cashFlow!.tree)).toBe(true);

    const perf = await json<{ groups: Array<{ key: string; salesSen: number; cogsSen: number; gpPct: number | null }>; totals: { gpPct: number | null } }>(await app.request('/accounting/reports/performance?from=2026-08-01&to=2026-08-31'));
    expect(aug.performance!.groups.map((g) => [g.key, g.salesSen, g.cogsSen, g.gpPct])).toEqual(perf.groups.map((g) => [g.key, g.salesSen, g.cogsSen, g.gpPct]));
    expect(aug.performance).toMatchObject({ salesSen: 400_000, cogsSen: 240_000, gpSen: 160_000, totalGpPct: 40 });
    expect(aug.performance!.totalGpPct).toBe(perf.totals.gpPct);

    const bs = await json<{ totals: Record<string, number> }>(await app.request('/accounting/reports/balance-sheet?asOf=2026-08-31'));
    expect(aug.balanceSheet).toMatchObject({ assetsSen: bs.totals.assetsSen, liabilitiesSen: bs.totals.liabilitiesSen, equitySen: bs.totals.equitySen, earningsSen: bs.totals.earningsSen, checkSen: 0 });
    expect(aug.balanceSheet).toMatchObject({ assetsSen: 137_000, liabilitiesSen: 68_000, equitySen: 50_000, earningsSen: 19_000, currentAssetsSen: 137_000, currentLiabilitiesSen: 68_000, inventorySen: 10_000, debtToAssetPct: 49.6 });
    expect(aug.ratios).toEqual({ grossMarginPct: 42, netMarginPct: 19, currentRatio: 2.01, quickRatio: 1.87, roePct: 27.5, roaPct: 13.9 });
  });

  test('the cost structure: Spend from the orders, Purchase from the bound accounts, Closing stock from the engine by category', async () => {
    const { payload } = await build();
    const aug = payload.periods[0]!.costStructure!.groups;
    expect(aug.map((g) => [g.key, g.spendSen, g.purchaseSen, g.closingStockSen])).toEqual([
      ['sofa', 180_000, 60_000, 10_000],
      ['bedding', 60_000, 8_000, 0],
      ['accessories', 0, 0, 0],
      ['dining', 0, 0, 0],
    ]);
    const sep = payload.periods[1]!.costStructure!.groups;
    expect(sep.map((g) => [g.key, g.spendSen, g.purchaseSen, g.closingStockSen])).toEqual([
      ['sofa', 120_000, 0, 10_000],
      ['bedding', 0, 0, 4_000],
      ['accessories', 0, 0, 0],
      ['dining', 0, 0, 0],
    ]);
  });

  test('the forecast is the grid\'s arithmetic per month, staff cost by the same category, null where no row; a future period has no actuals', async () => {
    const { payload } = await build();
    const [aug, sep, oct, nov] = payload.periods;
    expect(aug!.forecast).toBeNull();
    expect(sep!.forecast).toEqual({
      salesSen: 120_000, costOfSalesSen: 72_000, grossProfitSen: 48_000, otherIncomeSen: 0, expensesSen: 26_000, staffCostSen: 20_000, otherExpensesSen: 6_000,
      profitBeforeTaxSen: 22_000, taxationSen: 0, netProfitSen: 22_000,
    });
    expect(oct!.forecast).toBeNull();
    expect(nov!.forecast).toMatchObject({ salesSen: 150_000, costOfSalesSen: 90_000, grossProfitSen: 60_000, netProfitSen: 60_000 });
    for (const p of [oct!, nov!]) {
      expect(p.actual).toBeNull();
      expect(p.performance).toBeNull();
      expect(p.costStructure).toBeNull();
      expect(p.cashFlow).toBeNull();
      expect(p.balanceSheet).toBeNull();
      expect(p.ratios).toEqual({ grossMarginPct: null, netMarginPct: null, currentRatio: null, quickRatio: null, roePct: null, roaPct: null });
    }
    /* The running month reads its own actuals, provisional. */
    expect(sep!.actual).toMatchObject({ salesSen: 50_000, expensesSen: 2_000, staffCostSen: 0, otherExpensesSen: 2_000 });
  });
});

describe('buildDashboard — quarters', () => {
  test('a quarter adds its months and reads as the statement over the whole range', async () => {
    const { sb, app } = harness();
    const r = await buildDashboard(sb, CO, [CO], { granularity: 'quarter', periods: 1, from: null, to: null }, TODAY);
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.periods.map((p) => p.key)).toEqual(['2026-Q3', '2026-Q4']);
    const q3 = r.payload.periods[0]!;
    expect(q3).toMatchObject({ label: 'Q3 2026', from: '2026-07-01', to: '2026-09-30', partial: true });
    const pnl = await json<{ totals: Record<string, number> }>(await app.request('/accounting/reports/pnl?from=2026-07-01&to=2026-09-30'));
    expect(q3.actual).toMatchObject({ salesSen: pnl.totals.tradingIncomeSen, netProfitSen: pnl.totals.netProfitSen, staffCostSen: 20_000 });
    expect(q3.actual!.salesSen).toBe(150_000);
    /* Q3's forecast is September's alone; Q4's is November's. */
    expect(q3.forecast).toMatchObject({ salesSen: 120_000 });
    expect(r.payload.periods[1]!.forecast).toMatchObject({ salesSen: 150_000 });
    expect(r.payload.periods[1]!.actual).toBeNull();
  });
});

describe('GET /accounting/dashboard', () => {
  test('403 without the statements\' key', async () => {
    const { app } = harness([]);
    expect((await app.request('/accounting/dashboard')).status).toBe(403);
  });
  test('a bad query is a 400 sentence', async () => {
    const { app } = harness();
    const res = await app.request('/accounting/dashboard?granularity=week');
    expect(res.status).toBe(400);
    expect(await json<{ error: string; message: string }>(res)).toMatchObject({ error: 'bad_query', message: 'granularity must be month or quarter.' });
    expect((await app.request('/accounting/dashboard?from=2026-01')).status).toBe(400);
  });
  test('answers the range named and remembers it for a minute', async () => {
    const { app } = harness();
    const first = await json<DashboardPayload & { cached?: boolean }>(await app.request('/accounting/dashboard?from=2026-08&to=2026-09'));
    expect(first.periods.map((p) => p.key)).toEqual(['2026-08', '2026-09']);
    expect(first.periods[0]!.actual).toMatchObject({ salesSen: 100_000, netProfitSen: 19_000 });
    expect(first.cached).toBeUndefined();
    const again = await json<DashboardPayload & { cached?: boolean }>(await app.request('/accounting/dashboard?from=2026-08&to=2026-09'));
    expect(again.cached).toBe(true);
    expect(again.periods[0]!.actual).toEqual(first.periods[0]!.actual);
    clearDashboardCache();
    const fresh = await json<DashboardPayload & { cached?: boolean }>(await app.request('/accounting/dashboard?from=2026-08&to=2026-09'));
    expect(fresh.cached).toBeUndefined();
  });
});


/* Owner 2026-09-22 (loading 很慢): the preload read its tables one after
   another and the Performance / Cash Flow builders went back to the database
   for every period. Pinned: the window is read ONCE — the tables that were
   read per period are read a single time, and the number of reads does not
   grow with the number of periods. */
describe('buildDashboard — reads', () => {
  const countReads = async (periods: number) => {
    const { sb } = harness();
    const reads: string[] = [];
    const counted = { ...sb, from: (name: string) => { reads.push(name); return sb.from(name); } };
    const r = await buildDashboard(counted, CO, [CO], { granularity: 'month', periods, from: null, to: null }, TODAY);
    if (!r.ok) throw new Error(r.reason);
    return reads;
  };

  test('the window is read once — the orders, their lines, the settings and the ledger a single time, not once per period', async () => {
    const reads = await countReads(6);
    const count = (table: string) => reads.filter((n) => n === table).length;
    expect(count('mfg_sales_orders')).toBe(1);
    expect(count('mfg_sales_order_items')).toBe(1);
    expect(count('acc_company_settings')).toBe(1);
    expect(count('v_gl_entries')).toBe(1);
    expect(count('acc_forecast_pnl')).toBe(1);
  });

  test('the number of reads does not grow with the number of periods', async () => {
    const two = await countReads(2);
    const twelve = await countReads(12);
    expect(twelve.length).toBe(two.length);
  });
});
