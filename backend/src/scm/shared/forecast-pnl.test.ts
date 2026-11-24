/* The Forecast P&L's rules (owner 2026-09-21). Pinned: a cell is an amount OR
   a percent, a sales line an amount; the first bad cell is named; a percent
   line's amount is sales × bp / 10000 and an amount line's share is
   amount / sales; totals follow the P&L's blocks; a new month inherits the
   percentages and not the amounts. */
import { describe, expect, it } from 'vitest';
import {
  FORECAST_BLOCKS, OTHER_SUPPLIER, basisSalesSen, blockOfSection, forecastSalesSen, inheritMonth, inheritSuppliers, isPurchaseOfChart, monthFigures, nextMonth,
  sortedMonths, supplierFigures, validateGrid, validateSuppliers,
  type ForecastAccount,
} from './forecast-pnl';

const ACCOUNTS: ForecastAccount[] = [
  { code: '500-0003', name: 'SALES OF SOFA', section: 'SALES', type: 'INCOME' },
  { code: '500-0001', name: 'SALES OF BEDDING', section: 'SALES', type: 'INCOME' },
  { code: '520-0000', name: 'DISCOUNT ALLOWED', section: 'SALES ADJUSTMENTS', type: 'INCOME' },
  { code: '601-0003', name: 'PURCHASE OF SOFA', section: 'COST OF GOODS SOLD', type: 'EXPENSE' },
  { code: '601-0001', name: 'PURCHASES OF BEDDING', section: 'COST OF GOODS SOLD', type: 'EXPENSE' },
  { code: '590-0000', name: 'RENT RECEIVED', section: 'OTHER INCOMES', type: 'INCOME' },
  { code: '900-S100', name: 'STAFF SALARIES', section: 'EXPENSES', type: 'EXPENSE' },
  { code: '900-T003', name: 'TRANSPORT', section: 'EXPENSES', type: 'EXPENSE' },
  { code: '950-0000', name: 'TAXATION', section: 'TAXATION', type: 'EXPENSE' },
];

describe('the blocks', () => {
  it('files every P&L section into one of the five blocks and nothing else', () => {
    expect(FORECAST_BLOCKS.map((b) => b.key)).toEqual(['tradingIncome', 'costOfSales', 'otherIncome', 'expenses', 'taxation']);
    expect(blockOfSection('SALES ADJUSTMENTS')).toBe('tradingIncome');
    expect(blockOfSection('EXTRA-ORDINARY INCOME')).toBe('otherIncome');
    expect(blockOfSection('CURRENT ASSETS')).toBeNull();
  });
});

describe('validateGrid', () => {
  it('keeps a clean grid, months in order, cells as sent', () => {
    const r = validateGrid({
      '2026-11': { '500-0003': { amtSen: 5_000_000 } },
      '2026-10': { '500-0003': { amtSen: 10_000_000 }, '601-0003': { bp: 5500 }, '900-T003': { amtSen: 120_000 }, '520-0000': { amtSen: -50_000 } },
    }, ACCOUNTS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.grid)).toEqual(['2026-10', '2026-11']);
    expect(r.grid['2026-10']).toEqual({ '500-0003': { amtSen: 10_000_000 }, '601-0003': { bp: 5500 }, '900-T003': { amtSen: 120_000 }, '520-0000': { amtSen: -50_000 } });
  });

  it('names the first bad cell: a bad month, an unknown account, both keyed, an empty cell, a fraction, a negative percent, a percent on a sales line', () => {
    expect(validateGrid({ '2026-13': {} }, ACCOUNTS)).toEqual({ ok: false, cell: '2026-13', reason: 'not a month (YYYY-MM)' });
    expect(validateGrid({ '2026-10': { '999-0000': { bp: 1 } } }, ACCOUNTS)).toMatchObject({ ok: false, cell: '2026-10 999-0000' });
    expect(validateGrid({ '2026-10': { '601-0003': { bp: 1, amtSen: 1 } } }, ACCOUNTS)).toMatchObject({ ok: false, cell: '2026-10 601-0003', reason: 'a cell is an amount OR a percent, never both' });
    expect(validateGrid({ '2026-10': { '601-0003': {} } }, ACCOUNTS)).toMatchObject({ ok: false, cell: '2026-10 601-0003' });
    expect(validateGrid({ '2026-10': { '900-T003': { amtSen: 12.5 } } }, ACCOUNTS)).toEqual({ ok: false, cell: '2026-10 900-T003 amount', reason: 'amount must be a whole number of sen' });
    expect(validateGrid({ '2026-10': { '900-T003': { bp: -1 } } }, ACCOUNTS)).toMatchObject({ ok: false, cell: '2026-10 900-T003 percent' });
    expect(validateGrid({ '2026-10': { '500-0003': { bp: 10000 } } }, ACCOUNTS)).toMatchObject({ ok: false, cell: '2026-10 500-0003 percent', reason: expect.stringContaining('a sales line takes an amount') });
    expect(validateGrid([], ACCOUNTS)).toMatchObject({ ok: false, cell: 'months' });
  });
});

describe('monthFigures', () => {
  const OCT = {
    '500-0003': { amtSen: 8_000_000 }, '500-0001': { amtSen: 2_000_000 }, '520-0000': { amtSen: -50_000 },   // sales 99,500.00
    '601-0003': { bp: 5500 }, '601-0001': { amtSen: 900_000 },                                                // 54,725.00 + 9,000.00
    '590-0000': { bp: 100 },                                                                                  // 995.00
    '900-S100': { bp: 1200 }, '900-T003': { amtSen: 120_000 },                                                // 11,940.00 + 1,200.00
    '950-0000': { bp: 300 },                                                                                  // 2,985.00
  };

  it('a percent line takes sales × bp / 10000, an amount line its share of sales; totals follow the P&L', () => {
    const f = monthFigures(OCT, {}, ACCOUNTS);
    expect(f.salesSen).toBe(9_950_000);
    expect(forecastSalesSen(OCT, ACCOUNTS)).toBe(9_950_000);
    const by = new Map(f.lines.map((l) => [l.code, l]));
    expect(by.get('601-0003')).toMatchObject({ amountSen: 5_472_500, bp: 5500, keyed: 'percent', block: 'costOfSales' });
    expect(by.get('601-0001')).toMatchObject({ amountSen: 900_000, bp: 905, keyed: 'amount' });      // 9,000 / 99,500 = 9.05%
    expect(by.get('900-T003')).toMatchObject({ amountSen: 120_000, bp: 121 });                         // 1.21%
    expect(by.get('520-0000')).toMatchObject({ amountSen: -50_000, bp: -50, block: 'tradingIncome' });
    expect(f.totals).toEqual({
      tradingIncomeSen: 9_950_000,
      costOfSalesSen: 6_372_500,
      grossProfitSen: 3_577_500,
      otherIncomeSen: 99_500,
      expensesSen: 1_314_000,
      profitBeforeTaxSen: 2_363_000,
      taxationSen: 298_500,
      netProfitSen: 2_064_500,
    });
    /* Lines come in the accounts' order; a line not keyed is not a line. */
    expect(f.lines.map((l) => l.code)).toEqual(['500-0003', '500-0001', '520-0000', '601-0003', '601-0001', '590-0000', '900-S100', '900-T003', '950-0000']);
  });

  it('with no sales keyed a percent line is zero and an amount line has no share', () => {
    const f = monthFigures({ '601-0003': { bp: 5500 }, '900-T003': { amtSen: 120_000 } }, {}, ACCOUNTS);
    expect(f.salesSen).toBe(0);
    expect(f.lines.map((l) => [l.code, l.amountSen, l.bp])).toEqual([['601-0003', 0, 5500], ['900-T003', 120_000, null]]);
    expect(f.totals.netProfitSen).toBe(-120_000);
  });
});

/* A purchase line's % is of its OWN group's sales (owner 2026-09-29: purchase of
   bedding 应该是根据回他的 sales 的 amount 算，而不是 total sales, sofa 同理): the
   account carries `basis`, the sales accounts its item groups are bound to. */
describe("a line with a basis — a purchase account bound to its group's sales", () => {
  const BOUND: ForecastAccount[] = ACCOUNTS.map((a) =>
    (a.code === '601-0003' ? { ...a, basis: ['500-0003'] } : a.code === '601-0001' ? { ...a, basis: ['500-0001'] } : a));
  const OCT = { '500-0003': { amtSen: 8_000_000 }, '500-0001': { amtSen: 2_000_000 }, '601-0003': { bp: 5500 }, '601-0001': { amtSen: 900_000 }, '900-T003': { bp: 1200 } };

  it("a percent purchase line takes its own sales × bp; an amount purchase line's share is of its own sales; an expense line stays on the whole sales", () => {
    const f = monthFigures(OCT, {}, BOUND);
    expect(f.salesSen).toBe(10_000_000);
    const by = new Map(f.lines.map((l) => [l.code, l]));
    /* 55% of the SOFA sales (80,000), not of the 100,000 whole. */
    expect(by.get('601-0003')).toMatchObject({ amountSen: 4_400_000, bp: 5500, basisSen: 8_000_000, keyed: 'percent' });
    /* 9,000 of the BEDDING sales (20,000) = 45%, not 9% of the whole. */
    expect(by.get('601-0001')).toMatchObject({ amountSen: 900_000, bp: 4500, basisSen: 2_000_000, keyed: 'amount' });
    /* Transport is a share of everything sold. */
    expect(by.get('900-T003')).toMatchObject({ amountSen: 1_200_000, bp: 1200, basisSen: 10_000_000 });
    expect(f.totals.costOfSalesSen).toBe(5_300_000);
    expect(f.totals.grossProfitSen).toBe(4_700_000);
    expect(basisSalesSen(OCT, BOUND[3]!, f.salesSen)).toBe(8_000_000);
    expect(basisSalesSen(OCT, BOUND[7]!, f.salesSen)).toBe(10_000_000);
  });

  it('a group that sold nothing this month is a zero basis: its percent line is zero and its amount line has no share — the whole sales do not stand in', () => {
    const f = monthFigures({ '500-0003': { amtSen: 8_000_000 }, '601-0001': { bp: 5500 }, '601-0003': { amtSen: 100_000 } }, {}, BOUND);
    const by = new Map(f.lines.map((l) => [l.code, l]));
    expect(by.get('601-0001')).toMatchObject({ amountSen: 0, bp: 5500, basisSen: 0 });
    expect(by.get('601-0003')).toMatchObject({ amountSen: 100_000, bp: 125, basisSen: 8_000_000 });
    /* A basis of two sales lines adds them; an empty basis list is the whole sales. */
    const two = monthFigures({ '500-0003': { amtSen: 8_000_000 }, '500-0001': { amtSen: 2_000_000 }, '601-0001': { bp: 1000 } }, {},
      ACCOUNTS.map((a) => (a.code === '601-0001' ? { ...a, basis: ['500-0001', '500-0003'] } : a)));
    expect(two.lines.find((l) => l.code === '601-0001')).toMatchObject({ amountSen: 1_000_000, basisSen: 10_000_000 });
    const none = monthFigures({ '500-0003': { amtSen: 8_000_000 }, '601-0001': { bp: 1000 } }, {}, ACCOUNTS.map((a) => (a.code === '601-0001' ? { ...a, basis: [] } : a)));
    expect(none.lines.find((l) => l.code === '601-0001')).toMatchObject({ amountSen: 800_000, basisSen: 8_000_000 });
  });
});

describe('a new month', () => {
  it('inherits the percentages and none of the amounts; months sort; the next month rolls the year', () => {
    expect(inheritMonth({ '500-0003': { amtSen: 1 }, '601-0003': { bp: 5500 }, '900-T003': { amtSen: 5 }, '900-S100': { bp: 1200 } }))
      .toEqual({ '601-0003': { bp: 5500 }, '900-S100': { bp: 1200 } });
    expect(inheritMonth(undefined)).toEqual({});
    expect(sortedMonths({ '2026-12': {}, '2026-10': {}, '2027-01': {} })).toEqual(['2026-10', '2026-12', '2027-01']);
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(nextMonth('2026-09')).toBe('2026-10');
  });
});

/* A purchase account's month split by supplier (step 1 of the Hookka forecast
   port, 2026-11-24; Hookka tests/forecast-suppliers.test.mjs and
   forecast-supplier-pct.test.mjs, ported). Each supplier is an amount or a %;
   an account with any supplier figure that month IS their sum and its own cell
   is superseded; one without keeps its own; a supplier % is of the account's
   own basis, as the account's own % is. Made-up figures. */
describe('the purchase accounts are the purchases under Cost of Goods Sold', () => {
  const cogs = (name: string) => ({ section: 'COST OF GOODS SOLD', name });
  it('a line an item group posts its purchases to, or one the chart names a purchase; never a return, stock, carriage, or a line outside cost of sales', () => {
    expect(isPurchaseOfChart(cogs('PURCHASES OF BEDDING'), true)).toBe(true);
    expect(isPurchaseOfChart(cogs('SERVICE COSTS'), true)).toBe(true);                  // bound: its purchase invoices land there
    expect(isPurchaseOfChart(cogs('PURCHASE - TRANSPORT'), false)).toBe(true);           // named a purchase, not bound
    expect(isPurchaseOfChart(cogs('PURCHASE OF SOFA'), false)).toBe(true);
    expect(isPurchaseOfChart(cogs('PURCHASES RETURN'), false)).toBe(false);
    expect(isPurchaseOfChart(cogs('STOCKS AT THE BEGINNING OF YEAR - DISPLAY'), false)).toBe(false);
    expect(isPurchaseOfChart(cogs('STOCKS AT THE END OF YEAR'), false)).toBe(false);
    expect(isPurchaseOfChart(cogs('CARRIAGE INWARDS'), false)).toBe(false);
    expect(isPurchaseOfChart(cogs('DISCOUNT RECEIVED'), false)).toBe(false);
    expect(isPurchaseOfChart(cogs('COST OF PURCHASE BASED ON DEPOSIT (34%)'), false)).toBe(false);
    expect(isPurchaseOfChart({ section: 'EXPENSES', name: 'PURCHASE OF STATIONERY' }, true)).toBe(false);
    expect(isPurchaseOfChart({ section: 'SALES', name: 'PURCHASE REBATE' }, false)).toBe(false);
  });
});

describe('a purchase line split by supplier', () => {
  const ACC: ForecastAccount[] = [
    { code: '500-0003', name: 'SALES OF SOFA', section: 'SALES', type: 'INCOME' },
    { code: '500-0001', name: 'SALES OF BEDDING', section: 'SALES', type: 'INCOME' },
    { code: '601-0003', name: 'PURCHASE OF SOFA', section: 'COST OF GOODS SOLD', type: 'EXPENSE', purchase: true },
    { code: '601-0001', name: 'PURCHASES OF BEDDING', section: 'COST OF GOODS SOLD', type: 'EXPENSE', purchase: true },
    { code: '615-0000', name: 'CARRIAGE INWARDS', section: 'COST OF GOODS SOLD', type: 'EXPENSE' },
    { code: '900-T003', name: 'TRANSPORT', section: 'EXPENSES', type: 'EXPENSE' },
  ];
  /* Sales 100,000.00; sofa purchases 40% of sales, bedding 10%, carriage 700.00. */
  const LINES = { '500-0003': { amtSen: 6_000_000 }, '500-0001': { amtSen: 4_000_000 }, '601-0003': { bp: 4000 }, '601-0001': { bp: 1000 }, '615-0000': { amtSen: 70_000 } };
  const by = (f: ReturnType<typeof monthFigures>) => new Map(f.lines.map((l) => [l.code, l]));

  it('a line with supplier figures is their sum, not its own %; one without keeps its own; carriage stays', () => {
    const f = monthFigures(LINES, { '601-0003': { 's-1': { amtSen: 3_000_000 }, 's-2': { amtSen: 2_000_000 } } }, ACC);
    const l = by(f);
    expect(l.get('601-0003')).toMatchObject({ amountSen: 5_000_000, bp: 5000, keyed: 'suppliers' });
    expect(l.get('601-0003')!.bySupplier).toEqual([
      { supplierId: 's-1', amountSen: 3_000_000, bp: 3000, keyed: 'amount' },
      { supplierId: 's-2', amountSen: 2_000_000, bp: 2000, keyed: 'amount' },
    ]);
    expect(l.get('601-0001')).toMatchObject({ amountSen: 1_000_000, keyed: 'percent', bySupplier: [] });
    expect(l.get('615-0000')).toMatchObject({ amountSen: 70_000, keyed: 'amount' });
    expect(f.totals.costOfSalesSen).toBe(6_070_000);
    expect(f.totals.grossProfitSen).toBe(3_930_000);
    /* Cleared again, the line reads its own 40% again. */
    const back = by(monthFigures(LINES, { '601-0003': {} }, ACC));
    expect(back.get('601-0003')).toMatchObject({ amountSen: 4_000_000, keyed: 'percent', bySupplier: [] });
  });

  it("a supplier % is worked out against the month's sales beside the amounts; Other sits last", () => {
    const f = monthFigures(LINES, { '601-0003': { [OTHER_SUPPLIER]: { amtSen: 100_000 }, 's-9': { bp: 500 }, 's-1': { amtSen: 3_000_000 } } }, ACC);
    const line = by(f).get('601-0003')!;
    /* 5% of 100,000.00 = 5,000.00, beside 30,000.00 and 1,000.00: 36,000.00 = 36%. */
    expect(line.bySupplier.map((s) => [s.supplierId, s.amountSen, s.bp, s.keyed])).toEqual([
      ['s-1', 3_000_000, 3000, 'amount'], ['s-9', 500_000, 500, 'percent'], [OTHER_SUPPLIER, 100_000, 100, 'amount'],
    ]);
    expect(line).toMatchObject({ amountSen: 3_600_000, bp: 3600 });
    expect(f.totals.costOfSalesSen).toBe(3_600_000 + 1_000_000 + 70_000);
  });

  it("a supplier % on a line bound to its group's sales is of that group's sales, as the line's own % is", () => {
    const bound = ACC.map((a) => (a.code === '601-0001' ? { ...a, basis: ['500-0001'] } : a));
    const line = by(monthFigures(LINES, { '601-0001': { 's-1': { bp: 2500 } } }, bound)).get('601-0001')!;
    /* 25% of the 40,000.00 bedding sales, not of the 100,000.00 whole. */
    expect(line).toMatchObject({ amountSen: 1_000_000, bp: 2500, basisSen: 4_000_000, keyed: 'suppliers' });
  });

  it('a supplier % in a month without sales is 0, yet the line is still keyed by its suppliers', () => {
    const f = monthFigures({ '601-0003': { amtSen: 900_000 } }, { '601-0003': { 's-1': { bp: 500 } } }, ACC);
    expect(by(f).get('601-0003')).toMatchObject({ amountSen: 0, bp: null, keyed: 'suppliers' });
    expect(f.totals.costOfSalesSen).toBe(0);
  });

  it('supplier figures under a line that is not a purchase account count nowhere', () => {
    const f = monthFigures(LINES, { '615-0000': { 's-1': { amtSen: 9_999_900 } }, '900-T003': { 's-1': { amtSen: 1 } }, '999-0000': { 's-1': { amtSen: 1 } } }, ACC);
    expect(by(f).get('615-0000')).toMatchObject({ amountSen: 70_000, keyed: 'amount' });
    expect(by(f).has('900-T003')).toBe(false);
    expect(f.totals.costOfSalesSen).toBe(4_000_000 + 1_000_000 + 70_000);
    expect(supplierFigures({ '615-0000': { 's-1': { amtSen: 1 } } }, ACC[4]!, 0)).toEqual([]);
  });

  it('a line that is only supplier-keyed (no own cell) is a line', () => {
    const f = monthFigures({ '500-0003': { amtSen: 1_000_000 } }, { '601-0003': { 's-1': { amtSen: 250_000 } } }, ACC);
    expect(f.lines.map((l) => [l.code, l.amountSen, l.keyed])).toEqual([['500-0003', 1_000_000, 'amount'], ['601-0003', 250_000, 'suppliers']]);
  });

  describe('validateSuppliers', () => {
    const GRID = { '2026-10': {}, '2026-11': {} };
    const IDS = new Set(['s-1', 's-2']);
    it('keeps the figures as sent, drops an account or a month with no supplier left', () => {
      const r = validateSuppliers({
        '2026-11': { '601-0003': { 's-1': { amtSen: 3_000_000 }, [OTHER_SUPPLIER]: { bp: 250 } }, '601-0001': {} },
        '2026-10': { '601-0001': {} },
      }, GRID, ACC, IDS);
      expect(r).toEqual({ ok: true, suppliers: { '2026-11': { '601-0003': { 's-1': { amtSen: 3_000_000 }, [OTHER_SUPPLIER]: { bp: 250 } } } } });
      expect(validateSuppliers({}, GRID, ACC, IDS)).toEqual({ ok: true, suppliers: {} });
    });

    it('names the first bad cell: a month off the grid, an account that is not a purchase account, a supplier not of this company, the cell rules of a line', () => {
      const one = (raw: unknown) => validateSuppliers(raw, GRID, ACC, IDS);
      expect(one([])).toMatchObject({ ok: false, cell: 'suppliers' });
      expect(one({ '2026-13': {} })).toEqual({ ok: false, cell: '2026-13', reason: 'not a month (YYYY-MM)' });
      expect(one({ '2026-12': { '601-0003': { 's-1': { amtSen: 1 } } } })).toMatchObject({ ok: false, cell: '2026-12' });
      expect(one({ '2026-11': { '615-0000': { 's-1': { amtSen: 1 } } } })).toEqual({ ok: false, cell: '2026-11 615-0000', reason: 'only a purchase account is split by supplier' });
      expect(one({ '2026-11': { '999-0000': { 's-1': { amtSen: 1 } } } })).toMatchObject({ ok: false, cell: '2026-11 999-0000', reason: 'not an account on the P&L' });
      expect(one({ '2026-11': { '601-0003': { 's-other-company': { amtSen: 1 } } } })).toEqual({ ok: false, cell: '2026-11 601-0003 s-other-company', reason: 'not a supplier of this company' });
      expect(one({ '2026-11': { '601-0003': { 's-1': { amtSen: 1, bp: 1 } } } })).toMatchObject({ ok: false, cell: '2026-11 601-0003 s-1', reason: 'a cell is an amount OR a percent, never both' });
      expect(one({ '2026-11': { '601-0003': { 's-1': {} } } })).toMatchObject({ ok: false, cell: '2026-11 601-0003 s-1' });
      expect(one({ '2026-11': { '601-0003': { 's-1': { amtSen: 12.5 } } } })).toEqual({ ok: false, cell: '2026-11 601-0003 s-1 amount', reason: 'amount must be a whole number of sen' });
      expect(one({ '2026-11': { '601-0003': { 's-2': { bp: -1 } } } })).toMatchObject({ ok: false, cell: '2026-11 601-0003 s-2 percent' });
      expect(one({ '2026-11': { '601-0003': { 's-2': 500 } } })).toMatchObject({ ok: false, cell: '2026-11 601-0003 s-2', reason: 'a cell is { bp } or { amtSen }' });
      expect(one({ '2026-11': { '601-0003': [] } })).toMatchObject({ ok: false, cell: '2026-11 601-0003' });
    });
  });

  it("a new month carries each supplier's % and none of the amounts", () => {
    expect(inheritSuppliers({
      '601-0003': { 's-1': { bp: 2000 }, 's-2': { amtSen: 5 }, [OTHER_SUPPLIER]: { bp: 100 } },
      '601-0001': { 's-2': { amtSen: 7 } },
    })).toEqual({ '601-0003': { 's-1': { bp: 2000 }, [OTHER_SUPPLIER]: { bp: 100 } } });
    expect(inheritSuppliers(undefined)).toEqual({});
  });
});
