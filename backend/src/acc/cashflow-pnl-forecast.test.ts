/* The Forecast P&L as cash (step 2 of the Hookka forecast port; Hookka
   tests/cashflow-forecast.test.mjs and forecast-suppliers.test.mjs, the P&L
   forecast cases, ported). Pinned: the term words the supplier page offers →
   months; the mixes and the whole-sen spread; sales by the measured receipts
   (Deposit / Settlement, delay after the order month); a supplier-split
   purchase after each supplier's term, Other and a supplier with no term a
   month later (the latter named); a purchase keyed whole by its recent
   suppliers' terms; salaries the month after; other income, other costs and
   taxation in their month; non-cash lines left out and named; the months a
   column covers. Made-up figures. */
import { describe, expect, it } from 'vitest';
import {
  addMonthsYm, buildPnlCashLegs, forecastMonths, measuredWindow, monthsBetween, parseTermMonths, receiptMixOf, spreadSen, termMixOf,
  type CashLeg, type PnlCashInput,
} from './cashflow-pnl-forecast';
import type { ForecastAccount } from '../scm/shared/forecast-pnl';

describe('payment terms', () => {
  it("reads the supplier page's choices and the older free text; blank or anything else is a month later and flagged", () => {
    for (const t of ['COD', 'cash', 'C.O.D.', 'Advance Payment', '50/50', '30/70']) expect(parseTermMonths(t), t).toEqual({ months: 0, flagged: false });
    expect(parseTermMonths('NET 7')).toEqual({ months: 0, flagged: false });
    expect(parseTermMonths('NET 14')).toEqual({ months: 0, flagged: false });
    expect(parseTermMonths('NET 30')).toEqual({ months: 1, flagged: false });
    expect(parseTermMonths('NET30')).toEqual({ months: 1, flagged: false });
    expect(parseTermMonths('NET 45')).toEqual({ months: 2, flagged: false });
    expect(parseTermMonths('NET 60')).toEqual({ months: 2, flagged: false });
    expect(parseTermMonths('NET 90')).toEqual({ months: 3, flagged: false });
    expect(parseTermMonths('30 DAYS')).toEqual({ months: 1, flagged: false });
    expect(parseTermMonths('60 Days')).toEqual({ months: 2, flagged: false });
    expect(parseTermMonths('2 MONTHS')).toEqual({ months: 2, flagged: false });
    for (const t of [null, '', '   ', '30 terms', '+60000000000', 'NET 45 with 2% early discount']) expect(parseTermMonths(t), String(t)).toEqual({ months: 1, flagged: true });
  });
});

describe('months and mixes', () => {
  it('steps months across a year, measures from the 3 complete months before today', () => {
    expect(addMonthsYm('2026-11', 2)).toBe('2027-01');
    expect(addMonthsYm('2026-01', -1)).toBe('2025-12');
    expect(monthsBetween('2026-10', '2027-01')).toBe(3);
    expect(monthsBetween('2026-10', '2026-09')).toBe(-1);
    expect(measuredWindow('2026-11-24')).toEqual({ from: '2026-08-01', to: '2026-10-31' });
    expect(measuredWindow('2027-02-03')).toEqual({ from: '2026-11-01', to: '2027-01-31' });
  });

  it('a term mix adds the amounts per delay, shortest first; nothing to go by is a month later', () => {
    expect(termMixOf([{ months: 2, sen: 300 }, { months: 0, sen: 100 }, { months: 2, sen: 100 }, { months: 1, sen: 0 }, { months: -1, sen: 50 }]))
      .toEqual([{ months: 0, weight: 100 }, { months: 2, weight: 400 }]);
    expect(termMixOf([])).toEqual([{ months: 1, weight: 1 }]);
  });

  it('a receipts mix keeps Deposit and Settlement apart; money before the order month counts in it; nothing to go by is all a deposit in the order month', () => {
    expect(receiptMixOf([
      { kind: 'DEP', months: 0, sen: 600 }, { kind: 'BAL', months: 1, sen: 300 }, { kind: 'BAL', months: 0, sen: 50 }, { kind: 'DEP', months: -1, sen: 50 }, { kind: 'BAL', months: 2, sen: 0 },
    ])).toEqual([{ kind: 'DEP', months: 0, weight: 650 }, { kind: 'BAL', months: 0, weight: 50 }, { kind: 'BAL', months: 1, weight: 300 }]);
    expect(receiptMixOf([])).toEqual([{ kind: 'DEP', months: 0, weight: 1 }]);
  });

  it('a spread in whole sen adds back to the amount exactly, a negative one too', () => {
    const parts = spreadSen(1001, [{ months: 0, weight: 1 }, { months: 1, weight: 1 }, { months: 2, weight: 1 }]);
    expect(parts.map((p) => p.sen)).toEqual([334, 334, 333]);
    expect(spreadSen(-1001, [{ months: 0, weight: 1 }, { months: 1, weight: 1 }, { months: 2, weight: 1 }]).reduce((s, p) => s + p.sen, 0)).toBe(-1001);
    expect(spreadSen(0, [{ months: 0, weight: 1 }])).toEqual([]);
  });
});

const ACC: ForecastAccount[] = [
  { code: '500-0003', name: 'SALES OF SOFA', section: 'SALES', type: 'INCOME' },
  { code: '520-0000', name: 'DISCOUNT ALLOWED', section: 'SALES ADJUSTMENTS', type: 'INCOME' },
  { code: '601-0003', name: 'PURCHASE OF SOFA', section: 'COST OF GOODS SOLD', type: 'EXPENSE', purchase: true },
  { code: '601-0001', name: 'PURCHASES OF BEDDING', section: 'COST OF GOODS SOLD', type: 'EXPENSE', purchase: true },
  { code: '615-0000', name: 'CARRIAGE INWARDS', section: 'COST OF GOODS SOLD', type: 'EXPENSE' },
  { code: '620-0001', name: 'STOCKS AT THE END OF YEAR - CUSTOMER', section: 'COST OF GOODS SOLD', type: 'EXPENSE' },
  { code: '590-0000', name: 'RENT RECEIVED', section: 'OTHER INCOMES', type: 'INCOME' },
  { code: '900-S100', name: 'STAFF SALARIES & OVERTIME', section: 'EXPENSES', type: 'EXPENSE' },
  { code: '900-R001', name: 'RENTAL', section: 'EXPENSES', type: 'EXPENSE' },
  { code: '900-D001', name: 'DEPRECIATION OF FURNITURE', section: 'EXPENSES', type: 'EXPENSE' },
  { code: '950-0000', name: 'TAXATION', section: 'TAXATION', type: 'EXPENSE' },
];
const TERMS: Record<string, string | null> = { 'sup-a': 'NET 30', 'sup-b': null, 'sup-c': 'COD', 'sup-d': 'NET 60' };
const input = (o: Partial<PnlCashInput> = {}): PnlCashInput => ({
  grid: {}, suppliers: {}, accounts: ACC, arCode: '300-0000',
  receiptMix: [{ kind: 'DEP', months: 0, weight: 60 }, { kind: 'BAL', months: 1, weight: 40 }],
  purchaseMix: () => [{ months: 0, weight: 1 }, { months: 2, weight: 1 }],
  supplierTerm: (id) => parseTermMonths(TERMS[id] ?? null),
  supplierName: (id) => `Supplier ${id.slice(4).toUpperCase()}`,
  salaryCodes: new Set(['900-S100']),
  ...o,
});
const brief = (legs: CashLeg[]) => legs.map((l) => [l.ym, l.flow, l.key, l.sen]).sort((a, b) => String(a.join()).localeCompare(String(b.join())));

describe('the Forecast P&L as cash', () => {
  it('sales arrive by the receipts mix, each part a Deposit or a Settlement on the debtor control; a discount reduces them', () => {
    const r = buildPnlCashLegs(input({ grid: { '2026-12': { '500-0003': { amtSen: 10_100_000 }, '520-0000': { amtSen: -100_000 } } } }));
    expect(brief(r.legs)).toEqual([
      ['2026-12', 'in', '300-0000:DEP:FC', 6_000_000],
      ['2027-01', 'in', '300-0000:BAL:FC', 4_000_000],
    ]);
    expect(r.legs[0]).toMatchObject({ code: '300-0000', group: { id: 'DEP', label: 'Deposit' }, party: 'Forecast sales', fromYm: '2026-12' });
    expect(r.legs[1]).toMatchObject({ group: { id: 'BAL', label: 'Settlement' } });
  });

  it("a purchase split by supplier pays each after its own term; Other a month later; a supplier with no term a month later, and named", () => {
    const r = buildPnlCashLegs(input({
      grid: { '2026-12': { '500-0003': { amtSen: 10_000_000 }, '601-0003': { bp: 5500 } } },
      suppliers: { '2026-12': { '601-0003': { 'sup-a': { amtSen: 3_000_000 }, 'sup-b': { bp: 1000 }, 'sup-c': { amtSen: 500_000 }, 'sup-d': { amtSen: 200_000 }, other: { amtSen: 100_000 } } } },
      receiptMix: [{ kind: 'DEP', months: 0, weight: 1 }],
    }));
    const out = r.legs.filter((l) => l.flow === 'out');
    expect(out.map((l) => [l.ym, l.key, l.sen, l.party])).toEqual([
      ['2027-01', '601-0003', 3_000_000, 'Supplier A'],
      ['2027-01', '601-0003', 1_000_000, 'Supplier B'],
      ['2026-12', '601-0003', 500_000, 'Supplier C'],
      ['2027-02', '601-0003', 200_000, 'Supplier D'],
      ['2027-01', '601-0003', 100_000, 'Other (new suppliers)'],
    ]);
    /* The line's own 55% is superseded: 4,800,000 paid, not 5,500,000. */
    expect(out.reduce((s, l) => s + l.sen, 0)).toBe(4_800_000);
    expect(r.flagged).toEqual(['sup-b']);
    expect(out[1]!.note).toContain('no payment term set');
  });

  it("a purchase keyed whole pays by its own recent suppliers' terms", () => {
    const r = buildPnlCashLegs(input({
      grid: { '2026-12': { '601-0001': { amtSen: 1_000_001 } } },
      purchaseMix: (code) => (code === '601-0001' ? [{ months: 0, weight: 1 }, { months: 2, weight: 1 }] : [{ months: 1, weight: 1 }]),
    }));
    expect(brief(r.legs)).toEqual([['2026-12', 'out', '601-0001', 500_001], ['2027-02', 'out', '601-0001', 500_000]]);
  });

  it('salaries the month after; other income in, carriage, rent and tax out in their month; depreciation and stock left out and named', () => {
    const r = buildPnlCashLegs(input({
      grid: { '2026-12': {
        '900-S100': { amtSen: 2_000_000 }, '900-R001': { amtSen: 500_000 }, '590-0000': { amtSen: 80_000 }, '615-0000': { amtSen: 30_000 },
        '950-0000': { amtSen: 120_000 }, '900-D001': { amtSen: 70_000 }, '620-0001': { amtSen: -900_000 },
      } },
    }));
    expect(brief(r.legs)).toEqual([
      ['2026-12', 'in', '590-0000', 80_000],
      ['2026-12', 'out', '615-0000', 30_000],
      ['2026-12', 'out', '900-R001', 500_000],
      ['2026-12', 'out', '950-0000', 120_000],
      ['2027-01', 'out', '900-S100', 2_000_000],
    ]);
    expect(r.nonCash).toEqual([{ code: '620-0001', name: 'STOCKS AT THE END OF YEAR - CUSTOMER' }, { code: '900-D001', name: 'DEPRECIATION OF FURNITURE' }]);
    expect(r.legs.find((l) => l.key === '900-S100')!.note).toBe('Dec 2026 Forecast P&L · paid the month after');
  });

  it('a month with nothing keyed moves no money', () => {
    expect(buildPnlCashLegs(input({ grid: { '2026-12': {} } }))).toEqual({ legs: [], nonCash: [], flagged: [] });
  });
});

describe('the months a forecast column covers', () => {
  const leg = (ym: string): CashLeg => ({ ym, fromYm: '2026-11', source: 'pnl', flow: 'out', code: 'x', key: 'x', name: 'x', sen: 1, party: 'x', note: 'x' });
  it("the range; reaching the current month, every later month the money reaches, a year at most", () => {
    expect(forecastMonths('2026-09', '2026-11', '2026-11', [leg('2027-02'), leg('2026-10'), leg('2028-01')])).toEqual([
      { month: '2026-09', future: false }, { month: '2026-10', future: false }, { month: '2026-11', future: false },
      { month: '2026-12', future: true }, { month: '2027-01', future: true }, { month: '2027-02', future: true },
    ]);
    /* A range that ends before the current month shows no later month. */
    expect(forecastMonths('2026-08', '2026-09', '2026-11', [leg('2027-02')]).map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    /* Nothing later to show: the range alone. */
    expect(forecastMonths('2026-11', '2026-11', '2026-11', [])).toEqual([{ month: '2026-11', future: false }]);
  });
});
