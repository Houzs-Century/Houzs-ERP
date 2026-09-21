// The standard statements (GL redesign item 6, classified by SECTION since
// 2026-09-06). Pinned:
//   • the P&L reads the chart's sections — SALES + SALES ADJUSTMENTS above the
//     line, COST OF GOODS SOLD as cost of sales (the month-close 620 pair
//     INCLUDED — that is what makes gross profit read purchases + opening −
//     closing), OTHER INCOMES below gross, EXPENSES, then TAXATION under a
//     profit-before-tax line; the section wins over the code and the tree;
//   • a row the chart has not sectioned takes the default shelf for its
//     type — the migration's own rule, one home;
//   • reversed/unposted lines never count — and a reversal PAIR is nothing in
//     either month: the contra dated later is not that month's movement
//     (docs/bugs/0923);
//   • the balance sheet balances THROUGH current earnings, and its self-check
//     is zero on a clean ledger;
//   • bad dates are 400 sentences;
//   • the P&L hands the same figures back on the report's layout — the
//     chart's own tree when nothing is stored — with % of sales on every line
//     (docs/bugs/0911; the layout routes themselves: reportLayouts.test.ts);
//   • 2026-09-21: the stock lines come from the STOCK ENGINE as of the date,
//     not from the month-close pair in the GL — Opening stock as of the day
//     before the range, Closing stock as of its last day, one line per bucket
//     (customer / display / service), the GL's own 330 / 600 / 620 lines set
//     aside; the balance sheet's stock the same way, its earnings adjusted so
//     the self-check still reads zero; a closing the ledger has not booked
//     yet (the open month, a mid-month date) is flagged provisional.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { pnlReport, balanceSheetReport } from '../src/scm/routes/accounting-reports';

const CO = 2;

const ACCOUNTS: Row[] = [
  { company_id: CO, account_code: '310-0010', account_name: 'BANK', account_type: 'ASSET', parent_code: null, section: 'CURRENT ASSETS' },
  { company_id: CO, account_code: '330-0000', account_name: 'STOCK', account_type: 'ASSET', parent_code: null, section: 'CURRENT ASSETS' },
  { company_id: CO, account_code: '400-0000', account_name: 'AP', account_type: 'LIABILITY', parent_code: null, section: 'CURRENT LIABILITIES' },
  { company_id: CO, account_code: '501-0000', account_name: 'SALES', account_type: 'INCOME', parent_code: null, section: 'SALES' },
  { company_id: CO, account_code: '700-0000', account_name: 'Other Income', account_type: 'INCOME', parent_code: null, section: 'OTHER INCOMES' },
  { company_id: CO, account_code: '590-0000', account_name: 'RENT RECEIVED', account_type: 'INCOME', parent_code: '700-0000', section: 'OTHER INCOMES' },
  /* NOT under 700 — the SECTION alone puts it below gross profit. */
  { company_id: CO, account_code: '530-0000', account_name: 'COMMISSION RECEIVED', account_type: 'INCOME', parent_code: null, section: 'OTHER INCOMES' },
  { company_id: CO, account_code: '601-0003', account_name: 'PURCHASE OF SOFA', account_type: 'EXPENSE', parent_code: null, section: 'COST OF GOODS SOLD' },
  /* Older than the migration: NO section — the default shelf for a 6xx EXPENSE is cost of goods sold. */
  { company_id: CO, account_code: '615-0000', account_name: 'CARRIAGE INWARDS', account_type: 'EXPENSE', parent_code: null, section: null },
  { company_id: CO, account_code: '620-0000', account_name: 'STOCKS AT END', account_type: 'EXPENSE', parent_code: null, section: 'COST OF GOODS SOLD' },
  { company_id: CO, account_code: '600-0000', account_name: 'STOCKS AT BEGINNING', account_type: 'EXPENSE', parent_code: null, section: 'COST OF GOODS SOLD' },
  /* The bucket children the seed opens (2026-09-21): the engine's lines sit under their parents on the chart's tree. */
  ...['CUSTOMER', 'DISPLAY', 'SERVICE'].flatMap((b, i) => [
    { company_id: CO, account_code: `330-000${i + 1}`, account_name: `STOCK - ${b}`, account_type: 'ASSET', parent_code: '330-0000', section: 'CURRENT ASSETS' },
    { company_id: CO, account_code: `600-000${i + 1}`, account_name: `STOCKS AT THE BEGINNING OF YEAR - ${b}`, account_type: 'EXPENSE', parent_code: '600-0000', section: 'COST OF GOODS SOLD' },
    { company_id: CO, account_code: `620-000${i + 1}`, account_name: `STOCKS AT THE END OF YEAR - ${b}`, account_type: 'EXPENSE', parent_code: '620-0000', section: 'COST OF GOODS SOLD' },
  ]),
  { company_id: CO, account_code: '900-A001', account_name: 'ADVERT', account_type: 'EXPENSE', parent_code: '900-0000', section: 'EXPENSES' },
  { company_id: CO, account_code: '950-0000', account_name: 'TAXATION', account_type: 'EXPENSE', parent_code: null, section: 'TAXATION' },
];

const gl = (code: string, type: string, dr: number, cr: number, over: Row = {}): Row => ({
  company_id: CO, account_code: code, account_type: type,
  account_name: code, debit_sen: dr, credit_sen: cr,
  entry_date: '2026-08-15', posted: true, reversed: false, ...over,
});

/* The stock engine's side of the same month: RM100 of goods received on 10 August
   into no particular warehouse (= customer stock), the GL pair above being what
   the close booked for it. The reports read THIS for the stock lines. */
const MOVES: Row[] = [
  { company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 10_000, movement_date: '2026-08-10', created_at: '2026-08-10T02:00:00Z', item_code: 'SOFA-1', warehouse_id: null },
];

function harness(glRows: Row[], moves: Row[] = MOVES, warehouses: Row[] = []) {
  const sb = fakeSb({
    v_gl_entries: glRows, accounts: ACCOUNTS.map((r) => ({ ...r })), acc_report_layouts: [],
    inventory_movements: moves.map((r) => ({ ...r })), warehouses: warehouses.map((r) => ({ ...r })), acc_account_roles: [], journal_entries: [],
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('houzsUser' as never, { name: 'T', permissions_set: ['scm.payment_voucher.post'] } as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('companies' as never, [{ id: CO, code: '2990', name: '2990 Home' }] as never);
    await next();
  });
  app.get('/accounting/reports/pnl', pnlReport as never);
  app.get('/accounting/reports/balance-sheet', balanceSheetReport as never);
  return { app, sb };
}

/* One trading month in miniature: RM1,000 sale, RM600 purchases + RM10
   carriage (unsectioned row), RM100 closing stock (the month-close pair),
   RM50 rent received under 700 and RM20 commission NOT under 700 (section
   says other income), RM120 advertising, RM30 tax — plus a REVERSED line and
   an unposted draft that must not count. */
const WORLD: Row[] = [
  gl('501-0000', 'INCOME', 0, 100_000),
  gl('310-0010', 'ASSET', 100_000, 0),
  gl('601-0003', 'EXPENSE', 60_000, 0),
  gl('400-0000', 'LIABILITY', 0, 60_000),
  gl('615-0000', 'EXPENSE', 1_000, 0),
  gl('310-0010', 'ASSET', 0, 1_000),
  gl('330-0000', 'ASSET', 10_000, 0, { entry_date: '2026-08-31' }),   // closing stock pair
  gl('620-0000', 'EXPENSE', 0, 10_000, { entry_date: '2026-08-31' }),
  gl('590-0000', 'INCOME', 0, 5_000),
  gl('310-0010', 'ASSET', 5_000, 0),
  gl('530-0000', 'INCOME', 0, 2_000),
  gl('310-0010', 'ASSET', 2_000, 0),
  gl('900-A001', 'EXPENSE', 12_000, 0),
  gl('310-0010', 'ASSET', 0, 12_000),
  gl('950-0000', 'EXPENSE', 3_000, 0),
  gl('310-0010', 'ASSET', 0, 3_000),
  gl('501-0000', 'INCOME', 0, 999_999, { reversed: true }),
  gl('501-0000', 'INCOME', 0, 888_888, { posted: false }),
];

type Line = { code: string; section: string; amountSen: number };

/* An RM 1,610 sale keyed twice on 15 August: the original flagged reversed and
   pointing at its contra, the contra dated 15 September pointing back (the
   shape acc/engine.ts reverseJournal writes). Owner 2026-09-15 (docs/bugs/
   0923): 照理就是对冲掉，所以都不应该显示 — neither side is a movement of any month. */
const PAIR: Row[] = [
  gl('501-0000', 'INCOME', 0, 161_000, { reversed: true, reversed_by_je: 'je-contra' }),
  gl('310-0010', 'ASSET', 161_000, 0, { reversed: true, reversed_by_je: 'je-contra' }),
  gl('501-0000', 'INCOME', 161_000, 0, { entry_date: '2026-09-15', reversed_by_je: 'je-original' }),
  gl('310-0010', 'ASSET', 0, 161_000, { entry_date: '2026-09-15', reversed_by_je: 'je-original' }),
];

describe('GET /accounting/reports/pnl', () => {
  test('bad range is a 400', async () => {
    const { app } = harness([]);
    expect((await app.request('/accounting/reports/pnl?from=x&to=y')).status).toBe(400);
  });

  test('classifies by SECTION and the arithmetic holds down to net after tax', async () => {
    const { app } = harness(WORLD);
    const res = await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31');
    expect(res.status).toBe(200);
    const b = await res.json() as {
      tradingIncome: Line[]; costOfSales: Line[]; otherIncome: Line[]; expenses: Line[]; taxation: Line[];
      totals: Record<string, number>;
    };
    expect(b.tradingIncome.map((l) => [l.code, l.amountSen])).toEqual([['501-0000', 100_000]]);
    /* 615 has NO stored section — the default shelf for a 6xx EXPENSE; the
       closing stock is the ENGINE's RM100 as of 31 August on the customer
       bucket's account (the GL's own 620-0000 line is set aside), a CREDIT
       that reduces cost of sales — purchases + opening − closing. */
    expect(b.costOfSales.map((l) => [l.code, l.amountSen])).toEqual([['601-0003', 60_000], ['615-0000', 1_000], ['620-0001', -10_000]]);
    expect(b.costOfSales.map((l) => l.section)).toEqual(['COST OF GOODS SOLD', 'COST OF GOODS SOLD', 'COST OF GOODS SOLD']);
    expect(b.costOfSales.find((l) => l.code === '620-0001')).toMatchObject({ name: 'STOCKS AT THE END OF YEAR - CUSTOMER' });
    /* 530 sits at the root, not under 700 — its SECTION is what files it here. */
    expect(b.otherIncome.map((l) => l.code)).toEqual(['530-0000', '590-0000']);
    expect(b.expenses.map((l) => l.code)).toEqual(['900-A001']);
    expect(b.taxation.map((l) => [l.code, l.amountSen])).toEqual([['950-0000', 3_000]]);
    expect(b.totals).toMatchObject({
      tradingIncomeSen: 100_000,
      costOfSalesSen: 51_000,
      grossProfitSen: 49_000,
      otherIncomeSen: 7_000,
      expensesSen: 12_000,
      profitBeforeTaxSen: 44_000,
      taxationSen: 3_000,
      netProfitSen: 41_000,
    });
  });

  test('hands the same figures back on the layout — the chart\'s tree, % of sales on every line, totals unchanged', async () => {
    const { app } = harness(WORLD);
    const res = await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31');
    type Laid = { kind: string; label: string; amountSen: number; pct: number | null; children: Laid[] };
    const b = await res.json() as { layout: { stored: boolean; baseSen: number; tradingIncome: Laid[]; costOfSales: Laid[]; otherIncome: Laid[]; expenses: Laid[]; taxation: Laid[] }; totals: Record<string, number> };
    const flat = (nodes: Laid[]): unknown[] => nodes.map((n) => [n.label, n.amountSen, n.pct, ...(n.children.length > 0 ? [flat(n.children)] : [])]);
    expect(b.layout.stored).toBe(false);
    expect(b.layout.baseSen).toBe(100_000);
    /* Two sections in the block → a category per section; 700-0000 is a header → a category with a subtotal. */
    expect(flat(b.layout.tradingIncome)).toEqual([['SALES', 100_000, 100, [['501-0000 · 501-0000', 100_000, 100]]]]);
    expect(flat(b.layout.otherIncome)).toEqual([['OTHER INCOMES', 7_000, 7, [
      ['530-0000 · 530-0000', 2_000, 2],
      ['Other Income', 5_000, 5, [['590-0000 · 590-0000', 5_000, 5]]],
    ]]]);
    /* 900-A001's header (900-0000) is not on this chart → it is a root line. */
    expect(flat(b.layout.expenses)).toEqual([['900-A001 · 900-A001', 12_000, 12]]);
    /* The closing stock sits under its parent header on the chart's tree. */
    expect(flat(b.layout.costOfSales)).toEqual([['601-0003 · 601-0003', 60_000, 60], ['615-0000 · 615-0000', 1_000, 1], ['STOCKS AT END', -10_000, -10, [['620-0001 · STOCKS AT THE END OF YEAR - CUSTOMER', -10_000, -10]]]]);
    for (const [block, key] of [['costOfSales', 'costOfSalesSen'], ['expenses', 'expensesSen'], ['otherIncome', 'otherIncomeSen'], ['taxation', 'taxationSen']] as const) {
      expect(b.layout[block].reduce((s, n) => s + n.amountSen, 0)).toBe(b.totals[key]);
    }
  });
});

describe('a reversal pair is nothing in either month (docs/bugs/0923)', () => {
  test('the P&L: the September contra is not September\'s sales, and August keeps no trace of the original', async () => {
    const { app } = harness([...WORLD, ...PAIR]);
    const sep = await (await app.request('/accounting/reports/pnl?from=2026-09-01&to=2026-09-30')).json() as { tradingIncome: Line[]; totals: Record<string, number> };
    expect(sep.tradingIncome).toEqual([]);
    expect(sep.totals.tradingIncomeSen).toBe(0);
    expect(sep.totals.netProfitSen).toBe(0);
    const aug = await (await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31')).json() as { tradingIncome: Line[]; totals: Record<string, number> };
    expect(aug.tradingIncome.map((l) => [l.code, l.amountSen])).toEqual([['501-0000', 100_000]]);
    expect(aug.totals.netProfitSen).toBe(41_000);
  });

  test('the balance sheet as at 30 September carries neither leg on the bank', async () => {
    const { app } = harness([...WORLD, ...PAIR]);
    const b = await (await app.request('/accounting/reports/balance-sheet?asOf=2026-09-30')).json() as { assets: Line[]; totals: Record<string, number> };
    expect(b.assets.map((l) => [l.code, l.amountSen])).toEqual([['310-0010', 91_000], ['330-0001', 10_000]]);
    expect(b.totals).toMatchObject({ assetsSen: 101_000, earningsSen: 41_000, checkSen: 0 });
  });
});

describe('the stock lines read the engine as of the date (owner 2026-09-21: 报表选 8月31号就应该显示当时 stock 拥有的 amount)', () => {
  test('a range that starts after goods arrived opens on them and closes on what is left; the buckets each print their own line; the month-close pair in the GL never counts twice', async () => {
    const { app } = harness(WORLD, [
      ...MOVES,                                                                                                                  // customer 100.00 on 10 Aug
      { company_id: CO, movement_type: 'IN', qty: 1, total_cost_sen: 3_000, movement_date: '2026-08-20', created_at: '2026-08-20T02:00:00Z', item_code: 'MAT-1', warehouse_id: 'wh-show' },   // display 30.00
      { company_id: CO, movement_type: 'OUT', qty: 1, total_cost_sen: 2_500, movement_date: '2026-09-05', created_at: '2026-09-05T02:00:00Z', item_code: 'SOFA-1', warehouse_id: null },     // customer −25.00 in Sept
    ], [{ id: 'wh-show', company_id: CO, type: 'showroom', stock_bucket: null }]);
    /* September: opening = the engine as of 31 Aug (customer 100, display 30), closing = as of 30 Sept (customer 75, display 30). */
    const sep = await (await app.request('/accounting/reports/pnl?from=2026-09-01&to=2026-09-30')).json() as { costOfSales: Line[]; totals: Record<string, number>; stock: { closingProvisional: boolean; asOf: string } };
    expect(sep.costOfSales.map((l) => [l.code, l.amountSen])).toEqual([['600-0001', 10_000], ['600-0002', 3_000], ['620-0001', -7_500], ['620-0002', -3_000]]);
    expect(sep.totals.costOfSalesSen).toBe(2_500);
    /* No closing entry on file for September in this world: provisional. */
    expect(sep.stock).toEqual({ closingProvisional: true, asOf: '2026-09-30' });
    /* A mid-month date is always provisional, and reads the engine that day. */
    const mid = await (await app.request('/accounting/reports/pnl?from=2026-09-01&to=2026-09-21')).json() as { costOfSales: Line[]; stock: { closingProvisional: boolean } };
    expect(mid.costOfSales.map((l) => [l.code, l.amountSen])).toEqual([['600-0001', 10_000], ['600-0002', 3_000], ['620-0001', -7_500], ['620-0002', -3_000]]);
    expect(mid.stock.closingProvisional).toBe(true);
    /* August: no opening (nothing before 1 Aug), closing = both buckets. */
    const aug = await (await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31')).json() as { costOfSales: Line[]; totals: Record<string, number> };
    expect(aug.costOfSales.map((l) => [l.code, l.amountSen])).toEqual([['601-0003', 60_000], ['615-0000', 1_000], ['620-0001', -10_000], ['620-0002', -3_000]]);
    expect(aug.totals.costOfSalesSen).toBe(48_000);
    /* The balance sheet as at 30 Sept: stock 75 + 30 on the buckets' accounts; the self-check still reads zero. */
    const bs = await (await app.request('/accounting/reports/balance-sheet?asOf=2026-09-30')).json() as { assets: Line[]; totals: Record<string, number> };
    expect(bs.assets.map((l) => [l.code, l.amountSen])).toEqual([['310-0010', 91_000], ['330-0001', 7_500], ['330-0002', 3_000]]);
    expect(bs.totals.checkSen).toBe(0);
    expect(bs.totals.assetsSen).toBe(101_500);
  });

  test('a closing the ledger has booked is not provisional', async () => {
    const { app, sb } = harness(WORLD);
    sb.tables.journal_entries.push({ id: 'je-adj', company_id: CO, source_type: 'STOCKADJ', source_doc_no: `STOCKADJ-${CO}-2026-08`, reversed: false, je_no: '2990-JE-2608-0099', total_debit_sen: 10_000 });
    const aug = await (await app.request('/accounting/reports/pnl?from=2026-08-01&to=2026-08-31')).json() as { stock: { closingProvisional: boolean; asOf: string } };
    expect(aug.stock).toEqual({ closingProvisional: false, asOf: '2026-08-31' });
  });
});

describe('GET /accounting/reports/balance-sheet', () => {
  test('balances through current earnings — the self-check reads zero — and every line names its section', async () => {
    const { app } = harness(WORLD);
    const res = await app.request('/accounting/reports/balance-sheet?asOf=2026-08-31');
    expect(res.status).toBe(200);
    const b = await res.json() as { totals: Record<string, number>; assets: Line[]; liabilities: Line[] };
    // Bank 100k − 1k + 5k + 2k − 12k − 3k = 91k; stock 10k — the engine's, on the customer bucket's account.
    expect(b.assets.map((l) => [l.code, l.amountSen])).toEqual([['310-0010', 91_000], ['330-0001', 10_000]]);
    expect(b.assets.find((l) => l.code === '330-0001')).toMatchObject({ name: 'STOCK - CUSTOMER' });
    expect(b.assets.map((l) => l.section)).toEqual(['CURRENT ASSETS', 'CURRENT ASSETS']);
    expect(b.liabilities.map((l) => [l.code, l.section])).toEqual([['400-0000', 'CURRENT LIABILITIES']]);
    expect(b.totals).toMatchObject({
      assetsSen: 101_000,
      liabilitiesSen: 60_000,
      equitySen: 0,
      earningsSen: 41_000,
      checkSen: 0,
    });
  });

  test('hands the same figures back on the layout — a section layer, % of TOTAL ASSETS on every line of both sides (docs/bugs/0912)', async () => {
    const { app } = harness(WORLD);
    type Laid = { kind: string; label: string; amountSen: number; pct: number | null; children: Laid[] };
    const b = await (await app.request('/accounting/reports/balance-sheet?asOf=2026-08-31')).json() as { layout: { stored: boolean; baseSen: number; assets: Laid[]; liabilities: Laid[]; equity: Laid[] } };
    const flat = (nodes: Laid[]): unknown[] => nodes.map((n) => [n.label, n.amountSen, n.pct, ...(n.children.length > 0 ? [flat(n.children)] : [])]);
    expect(b.layout.stored).toBe(false);
    expect(b.layout.baseSen).toBe(101_000);
    expect(flat(b.layout.assets)).toEqual([['CURRENT ASSETS', 101_000, 100, [['310-0010 · 310-0010', 91_000, 90.1], ['STOCK', 10_000, 9.9, [['330-0001 · STOCK - CUSTOMER', 10_000, 9.9]]]]]]);
    /* The liability's % is of total assets too — 60,000 / 101,000. */
    expect(flat(b.layout.liabilities)).toEqual([['CURRENT LIABILITIES', 60_000, 59.4, [['400-0000 · 400-0000', 60_000, 59.4]]]]);
    expect(b.layout.equity).toEqual([]);
  });
});
