/* The Dashboard's pure arithmetic (owner 2026-09-21). Pinned: the periods a
   window is cut into — the last N ending on today's, a future forecast month
   extending the window, an explicit range taken as named, quarters rounded
   whole, the running and future periods marked partial; the product groups
   the cost structure is told in (Bedding = mattress + bedframe, service no
   group); months add up; the ratios divide by nothing gracefully. */
import { describe, expect, test } from 'vitest';
import {
  addFigures, addMonths, compareAccountsOf, compareGroupOfItemGroup, compareGroupOfPerformance, compareGroupOfPurchaseAccount, compareGroupOfSalesAccount,
  compareList, compareTotals, costGroupOfItemGroup, costGroupOfPerformance, costStructureList, emptyCompare, emptyCostStructure, emptyFigures,
  monthEnd, monthsBetween, periodsFor, quarterStart, ratiosOf,
} from './dashboard';

describe('month arithmetic', () => {
  test('addMonths crosses years both ways', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-09', -11)).toBe('2025-10');
  });
  test('monthEnd knows February and the 31-day months', () => {
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-09')).toBe('2026-09-30');
    expect(monthEnd('2026-10')).toBe('2026-10-31');
  });
  test('quarterStart and monthsBetween', () => {
    expect(quarterStart('2026-09')).toBe('2026-07');
    expect(quarterStart('2026-10')).toBe('2026-10');
    expect(monthsBetween('2026-01', '2026-12')).toBe(12);
    expect(monthsBetween('2026-12', '2026-01')).toBe(0);
  });
});

describe('periodsFor', () => {
  const today = '2026-09-21';
  test('the default window is the last N months ending on today\'s, the running month partial', () => {
    const ps = periodsFor({ granularity: 'month', periods: 3, today });
    expect(ps.map((p) => p.key)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(ps.map((p) => p.label)).toEqual(['07/2026', '08/2026', '09/2026']);
    expect(ps.map((p) => p.partial)).toEqual([false, false, true]);
    expect(ps[2]).toMatchObject({ from: '2026-09-01', to: '2026-09-30', months: ['2026-09'] });
  });
  test('a forecast month after today extends the window; one before does not', () => {
    const ps = periodsFor({ granularity: 'month', periods: 2, today, forecastMonths: ['2026-03', '2026-11'] });
    expect(ps.map((p) => p.key)).toEqual(['2026-08', '2026-09', '2026-10', '2026-11']);
    expect(ps.map((p) => p.partial)).toEqual([false, true, true, true]);
  });
  test('an explicit range is taken as named, whatever today is', () => {
    const ps = periodsFor({ granularity: 'month', periods: 12, from: '2026-02', to: '2026-04', today, forecastMonths: ['2026-12'] });
    expect(ps.map((p) => p.key)).toEqual(['2026-02', '2026-03', '2026-04']);
  });
  test('quarters round to whole quarters and read Qn YYYY', () => {
    const ps = periodsFor({ granularity: 'quarter', periods: 2, today });
    expect(ps.map((p) => p.key)).toEqual(['2026-Q2', '2026-Q3']);
    expect(ps[1]).toMatchObject({ label: 'Q3 2026', from: '2026-07-01', to: '2026-09-30', months: ['2026-07', '2026-08', '2026-09'], partial: true });
    expect(ps[0]!.partial).toBe(false);
    const ranged = periodsFor({ granularity: 'quarter', periods: 8, from: '2026-02', to: '2026-10', today });
    expect(ranged.map((p) => p.key)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4']);
  });
  test('a range ending before it starts collapses to its first period', () => {
    expect(periodsFor({ granularity: 'month', periods: 1, from: '2026-05', to: '2026-03', today }).map((p) => p.key)).toEqual(['2026-05']);
  });
});

describe('cost structure groups', () => {
  test('the product categories file under the owner\'s four; service is no group; the unknown is Others', () => {
    expect(costGroupOfItemGroup('SOFA')).toBe('sofa');
    expect(costGroupOfItemGroup('mattress')).toBe('bedding');
    expect(costGroupOfItemGroup('BEDFRAME')).toBe('bedding');
    expect(costGroupOfItemGroup('DINING')).toBe('dining');
    expect(costGroupOfItemGroup('BEDLINES')).toBe('accessories');
    expect(costGroupOfItemGroup('ACCESSORY')).toBe('accessories');
    expect(costGroupOfItemGroup('DIFFUSER')).toBe('accessories');
    expect(costGroupOfItemGroup('CARPET')).toBe('accessories');
    expect(costGroupOfItemGroup('SERVICE')).toBeNull();
    expect(costGroupOfItemGroup('SVC')).toBeNull();
    expect(costGroupOfItemGroup('LAMP')).toBe('others');
    expect(costGroupOfItemGroup(null)).toBe('others');
  });
  test('the Performance P&L\'s groups map the same way', () => {
    expect(costGroupOfPerformance('sofa')).toBe('sofa');
    expect(costGroupOfPerformance('mattress')).toBe('bedding');
    expect(costGroupOfPerformance('bedframe')).toBe('bedding');
    expect(costGroupOfPerformance('accessory')).toBe('accessories');
    expect(costGroupOfPerformance('dining')).toBe('dining');
    expect(costGroupOfPerformance('service')).toBeNull();
    expect(costGroupOfPerformance('others')).toBe('others');
  });
  test('the list keeps the owner\'s order and shows Others only when something landed there', () => {
    const by = emptyCostStructure();
    expect(costStructureList(by).map((g) => g.key)).toEqual(['sofa', 'bedding', 'accessories', 'dining']);
    by.others.closingStockSen = 500;
    expect(costStructureList(by).map((g) => g.key)).toEqual(['sofa', 'bedding', 'accessories', 'dining', 'others']);
  });
});

describe('figures and ratios', () => {
  test('months add up field by field', () => {
    const a = { ...emptyFigures(), salesSen: 100, netProfitSen: 10 };
    const b = { ...emptyFigures(), salesSen: 50, netProfitSen: -4 };
    expect(addFigures([a, b])).toMatchObject({ salesSen: 150, netProfitSen: 6, costOfSalesSen: 0 });
    expect(addFigures([])).toEqual(emptyFigures());
  });
  test('ratios divide, one decimal for %, two for a ratio, null with nothing to divide by', () => {
    const actual = { ...emptyFigures(), salesSen: 200_000, grossProfitSen: 90_000, netProfitSen: 15_000 };
    const bs = { assetsSen: 1_000_000, liabilitiesSen: 400_000, equitySen: 500_000, earningsSen: 100_000, currentAssetsSen: 300_000, currentLiabilitiesSen: 120_000, inventorySen: 90_000, debtToAssetPct: 40, checkSen: 0 };
    expect(ratiosOf(actual, bs)).toEqual({ grossMarginPct: 45, netMarginPct: 7.5, currentRatio: 2.5, quickRatio: 1.75, roePct: 2.5, roaPct: 1.5 });
    expect(ratiosOf(null, null)).toEqual({ grossMarginPct: null, netMarginPct: null, currentRatio: null, quickRatio: null, roePct: null, roaPct: null });
    expect(ratiosOf({ ...emptyFigures() }, { ...bs, currentLiabilitiesSen: 0, assetsSen: 0 })).toMatchObject({ grossMarginPct: null, currentRatio: null, roaPct: null });
  });
});

describe('performance vs forecast — the compare groups (owner 2026-09-22)', () => {
  test('an item group files under its compare group: Bedding = mattress + bedframe, Service its own, the rest Others', () => {
    expect(compareGroupOfItemGroup('MATTRESS')).toBe('bedding');
    expect(compareGroupOfItemGroup('BEDFRAME')).toBe('bedding');
    expect(compareGroupOfItemGroup('SOFA')).toBe('sofa');
    expect(compareGroupOfItemGroup('DINING')).toBe('dining');
    expect(compareGroupOfItemGroup('BEDLINES')).toBe('accessories');
    expect(compareGroupOfItemGroup('SERVICE')).toBe('service');
    expect(compareGroupOfItemGroup('SVC-TRANSPORT')).toBe('service');
    expect(compareGroupOfItemGroup('OTHERS')).toBe('others');
    expect(compareGroupOfItemGroup(null)).toBe('others');
    expect(compareGroupOfPerformance('mattress')).toBe('bedding');
    expect(compareGroupOfPerformance('accessory')).toBe('accessories');
    expect(compareGroupOfPerformance('service')).toBe('service');
    expect(compareGroupOfPerformance('others')).toBe('others');
  });

  test('the bindings give each group its accounts once, where first bound; an unclaimed account is Others', () => {
    const accounts = compareAccountsOf([
      { group_code: 'SOFA', sales_account: '500-0003', sales_return_account: '510-0003', purchase_account: '601-0003' },
      { group_code: 'MATTRESS', sales_account: '500-0001', sales_return_account: null, purchase_account: '601-0001' },
      { group_code: 'BEDFRAME', sales_account: '500-0001', sales_return_account: null, purchase_account: '601-0001' },
      { group_code: 'ACCESSORY', sales_account: '502-0000', sales_return_account: null, purchase_account: '602-0000' },
      { group_code: 'OTHERS', sales_account: '502-0000', sales_return_account: null, purchase_account: '601-0004' },
      { group_code: 'SERVICE', sales_account: '503-0000', sales_return_account: null, purchase_account: '604-0000' },
    ]);
    expect([...accounts.sales.get('sofa')!]).toEqual(['500-0003', '510-0003']);
    expect([...accounts.sales.get('bedding')!]).toEqual(['500-0001']);
    /* 502-0000 was bound to the accessories first: the OTHERS binding does not claim it again. */
    expect([...accounts.sales.get('accessories')!]).toEqual(['502-0000']);
    expect(accounts.sales.get('others')).toBeUndefined();
    expect([...accounts.purchase.get('others')!]).toEqual(['601-0004']);
    expect(compareGroupOfSalesAccount('500-0001', accounts)).toBe('bedding');
    expect(compareGroupOfSalesAccount('509-0000', accounts)).toBe('others');
    expect(compareGroupOfPurchaseAccount('604-0000', accounts)).toBe('service');
    expect(compareGroupOfPurchaseAccount('620-0000', accounts)).toBe('others');
  });

  test('the list reads each side, derives GP and GP %, keeps a missing side null, and hides an empty Others', () => {
    const by = emptyCompare();
    by.sofa.actualSalesSen = 90_000;
    by.sofa.performanceSalesSen = 100_000; by.sofa.performanceCostSen = 60_000;
    by.sofa.forecastSalesSen = 120_000; by.sofa.forecastCostSen = 72_000;
    by.service.performanceSalesSen = 5_000;
    const list = compareList(by, { actual: true, forecast: true });
    expect(list.map((g) => g.key)).toEqual(['sofa', 'bedding', 'dining', 'accessories', 'service']);
    expect(list[0]).toMatchObject({ actualSalesSen: 90_000, performanceGpSen: 40_000, performanceGpPct: 40, forecastGpSen: 48_000, forecastGpPct: 40 });
    expect(list[1]).toMatchObject({ actualSalesSen: 0, performanceGpSen: 0, performanceGpPct: null, forecastSalesSen: 0, forecastGpPct: null });
    expect(list[4]).toMatchObject({ performanceGpSen: 5_000, performanceGpPct: 100 });
    expect(compareTotals(by, { actual: true, forecast: true })).toEqual({
      actualSalesSen: 90_000, performanceSalesSen: 105_000, performanceCostSen: 60_000, performanceGpSen: 45_000, performanceGpPct: 42.9,
      forecastSalesSen: 120_000, forecastCostSen: 72_000, forecastGpSen: 48_000, forecastGpPct: 40,
    });
    /* A future period: no actual, no performance — null, never 0; a period with no forecast row: no forecast. */
    expect(compareTotals(by, { actual: false, forecast: true })).toMatchObject({ actualSalesSen: null, performanceSalesSen: null, performanceGpPct: null, forecastSalesSen: 120_000 });
    expect(compareList(by, { actual: true, forecast: false })[0]).toMatchObject({ actualSalesSen: 90_000, forecastSalesSen: null, forecastCostSen: null, forecastGpSen: null, forecastGpPct: null });
    by.others.actualSalesSen = 1;
    expect(compareList(by, { actual: true, forecast: true }).map((g) => g.key)).toContain('others');
  });
});
