/* The Forecast P&L's rules (owner 2026-09-21). Pinned: a cell is an amount OR
   a percent, a sales line an amount; the first bad cell is named; a percent
   line's amount is sales × bp / 10000 and an amount line's share is
   amount / sales; totals follow the P&L's blocks; a new month inherits the
   percentages and not the amounts. */
import { describe, expect, it } from 'vitest';
import {
  FORECAST_BLOCKS, blockOfSection, forecastSalesSen, inheritMonth, monthFigures, nextMonth, sortedMonths, validateGrid,
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
    const f = monthFigures(OCT, ACCOUNTS);
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
    const f = monthFigures({ '601-0003': { bp: 5500 }, '900-T003': { amtSen: 120_000 } }, ACCOUNTS);
    expect(f.salesSen).toBe(0);
    expect(f.lines.map((l) => [l.code, l.amountSen, l.bp])).toEqual([['601-0003', 0, 5500], ['900-T003', 120_000, null]]);
    expect(f.totals.netProfitSen).toBe(-120_000);
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
