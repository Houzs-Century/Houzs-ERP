/* The Financial Dashboard page (owner 2026-09-21). Pinned: the periods read
   as the server labels them, " *" on one not finished, the provisional-stock
   note; the Income Statement's rows — actual, its % of ACTUAL revenue, the
   forecast, its % of FORECAST revenue, the gap in RM and in points coloured
   by better / worse, vs last period — and the tabs; the forecast line
   breaks where a period has no forecast; Monthly / Quarterly and the range
   reach the query; the cost structure's measures and Show pills (a pill off takes
   a group from the chart, never from the table; Show all / Clear); the cash flow's tabs and
   detail; the Performance card's three readings per group, its group and
   metric tabs — its table side by side, the readings under each period, a row
   a group (owner 2026-09-29: 左右左右，不要上下); the ratios. The server half is backend/tests/accountingDashboard.test.ts. */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { CompareGroup, CompareTotals, DashboardCompare, DashboardFigures, DashboardParams, DashboardPayload, DashboardPeriod } from '../../vendor/scm/lib/dashboard-queries';

const figures = (over: Partial<DashboardFigures>): DashboardFigures => ({
  salesSen: 0, costOfSalesSen: 0, grossProfitSen: 0, otherIncomeSen: 0, expensesSen: 0, staffCostSen: 0, otherExpensesSen: 0, profitBeforeTaxSen: 0, taxationSen: 0, netProfitSen: 0, ...over,
});
const compareGroup = (key: string, label: string, over: Partial<CompareTotals>): CompareGroup => ({
  key, label, actualSalesSen: 0, performanceSalesSen: 0, performanceCostSen: 0, performanceGpSen: 0, performanceGpPct: null,
  forecastSalesSen: null, forecastCostSen: null, forecastGpSen: null, forecastGpPct: null, ...over,
});
const AUG_COMPARE: DashboardCompare = {
  groups: [
    compareGroup('sofa', 'Sofa', { actualSalesSen: 8_000_000, performanceSalesSen: 30_000_000, performanceCostSen: 18_000_000, performanceGpSen: 12_000_000, performanceGpPct: 40 }),
    compareGroup('bedding', 'Bedding', { actualSalesSen: 2_000_000, performanceSalesSen: 10_000_000, performanceCostSen: 6_000_000, performanceGpSen: 4_000_000, performanceGpPct: 40 }),
  ],
  totals: { actualSalesSen: 10_000_000, performanceSalesSen: 40_000_000, performanceCostSen: 24_000_000, performanceGpSen: 16_000_000, performanceGpPct: 40, forecastSalesSen: null, forecastCostSen: null, forecastGpSen: null, forecastGpPct: null },
};
const SEP_COMPARE: DashboardCompare = {
  groups: [
    compareGroup('sofa', 'Sofa', { actualSalesSen: 5_000_000, performanceSalesSen: 20_000_000, performanceCostSen: 12_000_000, performanceGpSen: 8_000_000, performanceGpPct: 40, forecastSalesSen: 10_000_000, forecastCostSen: 6_000_000, forecastGpSen: 4_000_000, forecastGpPct: 40 }),
    compareGroup('bedding', 'Bedding', { forecastSalesSen: 0, forecastCostSen: 0, forecastGpSen: 0, forecastGpPct: null }),
    compareGroup('dining', 'Dining', { forecastSalesSen: 2_000_000, forecastCostSen: 1_200_000, forecastGpSen: 800_000, forecastGpPct: 40 }),
  ],
  totals: { actualSalesSen: 5_000_000, performanceSalesSen: 20_000_000, performanceCostSen: 12_000_000, performanceGpSen: 8_000_000, performanceGpPct: 40, forecastSalesSen: 12_000_000, forecastCostSen: 7_200_000, forecastGpSen: 4_800_000, forecastGpPct: 40 },
};
const OCT_COMPARE: DashboardCompare = {
  groups: [compareGroup('sofa', 'Sofa', { actualSalesSen: null, performanceSalesSen: null, performanceCostSen: null, performanceGpSen: null, forecastSalesSen: 15_000_000, forecastCostSen: 9_000_000, forecastGpSen: 6_000_000, forecastGpPct: 40 })],
  totals: { actualSalesSen: null, performanceSalesSen: null, performanceCostSen: null, performanceGpSen: null, performanceGpPct: null, forecastSalesSen: 15_000_000, forecastCostSen: 9_000_000, forecastGpSen: 6_000_000, forecastGpPct: 40 },
};
const nullRatios = { grossMarginPct: null, netMarginPct: null, currentRatio: null, quickRatio: null, roePct: null, roaPct: null };
const AUG: DashboardPeriod = {
  key: '2026-08', label: '08/2026', from: '2026-08-01', to: '2026-08-31', months: ['2026-08'], partial: false,
  actual: figures({ salesSen: 10_000_000, costOfSalesSen: 5_800_000, grossProfitSen: 4_200_000, otherIncomeSen: 300_000, expensesSen: 2_500_000, staffCostSen: 2_000_000, otherExpensesSen: 500_000, profitBeforeTaxSen: 2_000_000, taxationSen: 100_000, netProfitSen: 1_900_000 }),
  forecast: null,
  performance: { groups: [{ key: 'sofa', label: 'Sofa', salesSen: 30_000_000, cogsSen: 18_000_000, gpSen: 12_000_000, gpPct: 40 }, { key: 'mattress', label: 'Mattress', salesSen: 10_000_000, cogsSen: 6_000_000, gpSen: 4_000_000, gpPct: 40 }], salesSen: 40_000_000, cogsSen: 24_000_000, gpSen: 16_000_000, totalGpPct: 40 },
  compare: AUG_COMPARE,
  costStructure: { groups: [
    { key: 'sofa', label: 'Sofa', spendSen: 18_000_000, purchaseSen: 6_000_000, closingStockSen: 1_000_000 },
    { key: 'bedding', label: 'Bedding', spendSen: 6_000_000, purchaseSen: 800_000, closingStockSen: 0 },
    { key: 'accessories', label: 'Accessories', spendSen: 0, purchaseSen: 0, closingStockSen: 0 },
    { key: 'dining', label: 'Dining', spendSen: 0, purchaseSen: 0, closingStockSen: 0 },
  ] },
  cashFlow: { inSen: 10_300_000, outSen: 2_600_000, netSen: 7_700_000, openingSen: 5_000_000, closingSen: 12_700_000, tree: [
    { kind: 'category', id: 'side:in', label: 'Receipts', amountSen: 10_300_000, pct: null, flow: 'in', children: [] },
    { kind: 'category', id: 'side:out', label: 'Payments', amountSen: 2_600_000, pct: null, flow: 'out', children: [] },
  ] },
  balanceSheet: { assetsSen: 13_700_000, liabilitiesSen: 6_800_000, equitySen: 5_000_000, earningsSen: 1_900_000, currentAssetsSen: 13_700_000, currentLiabilitiesSen: 6_800_000, inventorySen: 1_000_000, debtToAssetPct: 49.6, checkSen: 0 },
  ratios: { grossMarginPct: 42, netMarginPct: 19, currentRatio: 2.01, quickRatio: 1.87, roePct: 27.5, roaPct: 13.9 },
  stock: { closingProvisional: false },
};
const SEP: DashboardPeriod = {
  ...AUG, key: '2026-09', label: '09/2026', from: '2026-09-01', to: '2026-09-30', months: ['2026-09'], partial: true,
  actual: figures({ salesSen: 5_000_000, costOfSalesSen: 3_000_000, grossProfitSen: 2_000_000, expensesSen: 200_000, otherExpensesSen: 200_000, profitBeforeTaxSen: 1_800_000, netProfitSen: 1_800_000 }),
  forecast: figures({ salesSen: 12_000_000, costOfSalesSen: 7_200_000, grossProfitSen: 4_800_000, expensesSen: 2_600_000, staffCostSen: 2_000_000, otherExpensesSen: 600_000, profitBeforeTaxSen: 2_200_000, netProfitSen: 2_200_000 }),
  performance: { groups: [{ key: 'sofa', label: 'Sofa', salesSen: 20_000_000, cogsSen: 12_000_000, gpSen: 8_000_000, gpPct: 40 }], salesSen: 20_000_000, cogsSen: 12_000_000, gpSen: 8_000_000, totalGpPct: 40 },
  compare: SEP_COMPARE,
  costStructure: { groups: [
    { key: 'sofa', label: 'Sofa', spendSen: 12_000_000, purchaseSen: 0, closingStockSen: 1_000_000 },
    { key: 'bedding', label: 'Bedding', spendSen: 0, purchaseSen: 0, closingStockSen: 400_000 },
    { key: 'accessories', label: 'Accessories', spendSen: 0, purchaseSen: 0, closingStockSen: 0 },
    { key: 'dining', label: 'Dining', spendSen: 0, purchaseSen: 0, closingStockSen: 0 },
  ] },
  cashFlow: { inSen: 5_000_000, outSen: 200_000, netSen: 4_800_000, openingSen: 12_700_000, closingSen: 17_500_000, tree: [] },
  stock: { closingProvisional: true },
};
const OCT: DashboardPeriod = {
  key: '2026-10', label: '10/2026', from: '2026-10-01', to: '2026-10-31', months: ['2026-10'], partial: true,
  actual: null, forecast: figures({ salesSen: 15_000_000, costOfSalesSen: 9_000_000, grossProfitSen: 6_000_000, profitBeforeTaxSen: 6_000_000, netProfitSen: 6_000_000 }),
  performance: null, compare: OCT_COMPARE, costStructure: null, cashFlow: null, balanceSheet: null, ratios: nullRatios, stock: { closingProvisional: true },
};
const PAYLOAD: DashboardPayload = {
  granularity: 'month', today: '2026-09-21', window: { from: '2026-08-01', to: '2026-10-31' }, forecastMonths: ['2026-09', '2026-10'],
  groups: { performance: [{ key: 'sofa', label: 'Sofa' }, { key: 'mattress', label: 'Mattress' }, { key: 'bedframe', label: 'Bedframe' }], compare: [{ key: 'sofa', label: 'Sofa' }, { key: 'bedding', label: 'Bedding' }, { key: 'dining', label: 'Dining' }, { key: 'accessories', label: 'Accessories' }, { key: 'service', label: 'Service' }, { key: 'others', label: 'Others' }], costStructure: [{ key: 'sofa', label: 'Sofa' }, { key: 'bedding', label: 'Bedding' }, { key: 'accessories', label: 'Accessories' }, { key: 'dining', label: 'Dining' }, { key: 'others', label: 'Others' }] },
  periods: [AUG, SEP, OCT],
};
const lastParams: { value: DashboardParams | null } = { value: null };
vi.mock('../../vendor/scm/lib/dashboard-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useFinanceDashboard: (p: DashboardParams) => { lastParams.value = p; return { data: PAYLOAD, isLoading: false, isFetching: false, isError: false, error: null }; },
}));
const { FinanceDashboard } = await import('./FinanceDashboard');

const rowText = (id: string): string => String((document.querySelector(`[data-row="${id}"]`) as HTMLElement).textContent);
/** The chart nodes inside one card, by the card's title. */
const inCard = (title: string, selector: string): number => screen.getByLabelText(title).querySelectorAll(selector).length;
const cells = (id: string): string[] => [...(document.querySelector(`[data-row="${id}"]`) as HTMLElement).querySelectorAll('td')].slice(1).map((c) => String(c.textContent));
/** A side-by-side row's cells, per period and reading: the figure, then its grey % when it has one. */
const side = (id: string): string[] => [...(document.querySelector(`[data-row="${id}"]`) as HTMLElement).querySelectorAll('td[data-cell]')]
  .map((c) => [c.querySelector('[data-v]')?.textContent, c.querySelector('[data-pct]')?.textContent].filter((t): t is string => !!t).join(' '));

beforeEach(() => { lastParams.value = null; });

describe('the Financial Dashboard page', () => {
  test('reads the periods as labelled, marks the unfinished ones, and names the provisional stock', () => {
    render(<MemoryRouter><FinanceDashboard /></MemoryRouter>);
    /* The Income Statement's table carries every line of the statement now, not one metric (2026-09-29). */
    const table = screen.getByLabelText('Income statement figures');
    expect(within(table).getByText('08/2026')).toBeTruthy();
    expect(within(table).getByText('09/2026 *')).toBeTruthy();
    expect(within(table).getByText('10/2026 *')).toBeTruthy();
    expect(screen.getByText(/not finished — a small figure is not a fall/)).toBeTruthy();
    expect(screen.getByText(/Closing stock for 09\/2026 \* is what the shelves hold today/)).toBeTruthy();
    expect(lastParams.value).toEqual({ granularity: 'month', from: null, to: null });
  });

  /* Side by side too (owner 2026-09-29: Income Statement 也改): every line of the
     statement a row, under each period Actual | Forecast, the grey % of that
     reading's own revenue; the tab's gaps below. */
  test('the Income Statement: every line a row, actual and forecast side by side under each period with their own %, the tab\'s gap in RM and points coloured, vs last month', () => {
    render(<MemoryRouter><FinanceDashboard /></MemoryRouter>);
    const table = screen.getByLabelText('Income statement figures');
    expect([...table.querySelectorAll('th[data-source]')].map((h) => h.textContent)).toEqual(['Actual', 'Forecast', 'Actual', 'Forecast', 'Actual', 'Forecast']);
    expect([...table.querySelectorAll('tbody tr[data-row^="is:"]')].map((r) => r.getAttribute('data-row'))).toEqual(['is:revenue', 'is:cogs', 'is:gp', 'is:staff', 'is:other', 'is:net']);
    /* Revenue carries no %; every other line its share of THAT reading's revenue — an actual of actual, a forecast of forecast. */
    expect(side('is:revenue')).toEqual(['100,000.00', '—', '50,000.00', '120,000.00', '—', '150,000.00']);
    expect(side('is:cogs')).toEqual(['58,000.00 58.0%', '—', '30,000.00 60.0%', '72,000.00 60.0%', '—', '90,000.00 60.0%']);
    expect(side('is:gp')).toEqual(['42,000.00 42.0%', '—', '20,000.00 40.0%', '48,000.00 40.0%', '—', '60,000.00 40.0%']);
    expect(side('is:staff')).toEqual(['20,000.00 20.0%', '—', '0.00 0.0%', '20,000.00 16.7%', '—', '0.00 0.0%']);
    expect(side('is:other')).toEqual(['5,000.00 5.0%', '—', '2,000.00 4.0%', '6,000.00 5.0%', '—', '0.00 0.0%']);
    expect(side('is:net')).toEqual(['19,000.00 19.0%', '—', '18,000.00 36.0%', '22,000.00 18.3%', '—', '60,000.00 40.0%']);
    /* The tab's metric keeps its gaps, one figure a period, named for the metric. */
    expect(cells('vs-forecast')).toEqual(['—', '(70,000.00)', '—']);
    expect(cells('vs-last')).toEqual(['—', '-50.0%', '—']);
    expect(rowText('vs-forecast')).toContain('Revenue vs Forecast (RM)');
    /* The old stacked rows are gone. */
    expect(document.querySelector('[data-row="actual"]')).toBeNull();
    expect(document.querySelector('[data-row="forecast-pct"]')).toBeNull();
    /* The forecast's line has one segment (Sep → Oct) and two points: August has no forecast, so nothing is drawn there. */
    expect(document.querySelectorAll('[data-segment="forecast"]').length).toBe(1);
    expect(document.querySelectorAll('[data-point="forecast"]').length).toBe(2);
    expect(inCard('Income Statement', '[data-group="actual"]')).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Net Profit' }));
    expect(rowText('vs-forecast')).toContain('Net Profit vs Forecast (RM)');
    /* Net profit under forecast is worse: red; a cost under forecast would be green. */
    const gapCell = (document.querySelector('[data-row="vs-forecast"]') as HTMLElement).querySelectorAll('td')[2]!;
    expect(gapCell.textContent).toBe('(4,000.00)');
    expect(gapCell.style.color).toContain('B8331F');
    fireEvent.click(screen.getByRole('tab', { name: 'COGS' }));
    const cogsGap = (document.querySelector('[data-row="vs-forecast"]') as HTMLElement).querySelectorAll('td')[2]!;
    expect(cogsGap.textContent).toBe('(42,000.00)');
    expect(cogsGap.style.color).toContain('2F5D4F');
    /* The rows do not change with the tab — the whole statement stays on the table. */
    expect(side('is:net')).toEqual(['19,000.00 19.0%', '—', '18,000.00 36.0%', '22,000.00 18.3%', '—', '60,000.00 40.0%']);
  });

  test('Monthly / Quarterly and the range reach the query', () => {
    render(<MemoryRouter><FinanceDashboard /></MemoryRouter>);
    fireEvent.click(screen.getByRole('tab', { name: 'Quarterly' }));
    expect(lastParams.value).toMatchObject({ granularity: 'quarter', from: null, to: null });
    fireEvent.change(screen.getByLabelText('From month'), { target: { value: '2026-07' } });
    expect(lastParams.value).toMatchObject({ from: null, to: null });
    fireEvent.change(screen.getByLabelText('To month'), { target: { value: '2026-09' } });
    expect(lastParams.value).toMatchObject({ granularity: 'quarter', from: '2026-07', to: '2026-09' });
    fireEvent.click(screen.getByText('Reset'));
    expect(lastParams.value).toMatchObject({ from: null, to: null });
  });

  /* The table side by side (owner 2026-09-29: comparison 可以是左右左右吗？像我给你的
     sample，不要上下): under each period its readings, a row per group with the
     total under them, the grey % beside a figure; the gaps below, one figure a period. */
  test('the Performance card: actual and performance bars side by side, the forecast a line; the table puts the readings side by side under each period, a row a group; a group narrows everything; gross profit and GP % compare the orders with the forecast', () => {
    render(<MemoryRouter><FinanceDashboard /></MemoryRouter>);
    const table = screen.getByLabelText('Performance figures');
    /* Each period splits into the three readings, left to right. */
    expect([...table.querySelectorAll('th[data-source]')].map((h) => h.textContent)).toEqual([
      'Actual (P&L)', 'Performance (SO)', 'Forecast', 'Actual (P&L)', 'Performance (SO)', 'Forecast', 'Actual (P&L)', 'Performance (SO)', 'Forecast',
    ]);
    /* A row a group — its share of the column's sales in grey — then the total. */
    expect(side('perf:sofa')).toEqual([
      '80,000.00 80.0%', '300,000.00 75.0%', '—',
      '50,000.00 100.0%', '200,000.00 100.0%', '100,000.00 83.3%',
      '—', '—', '150,000.00 100.0%',
    ]);
    expect(side('perf:bedding')).toEqual([
      '20,000.00 20.0%', '100,000.00 25.0%', '—',
      '0.00 0.0%', '0.00 0.0%', '0.00 0.0%',
      '—', '—', '—',
    ]);
    expect(side('perf:dining')).toEqual(['—', '—', '—', '0.00 0.0%', '0.00 0.0%', '20,000.00 16.7%', '—', '—', '—']);
    expect(side('perf:total')).toEqual(['100,000.00', '400,000.00', '—', '50,000.00', '200,000.00', '120,000.00', '—', '—', '150,000.00']);
    expect([...table.querySelectorAll('tbody tr[data-row^="perf:"]')].map((r) => r.getAttribute('data-row'))).toEqual(['perf:sofa', 'perf:bedding', 'perf:dining', 'perf:total']);
    /* The gaps: one figure per period. */
    expect(cells('actual-vs-forecast')).toEqual(['—', '(70,000.00)', '—']);
    expect(cells('actual-vs-forecast-pct')).toEqual(['—', '-58.3%', '—']);
    expect(cells('performance-vs-forecast')).toEqual(['—', '+80,000.00', '—']);
    expect(cells('actual-vs-performance')).toEqual(['(300,000.00)', '(150,000.00)', '—']);
    /* The old stacked rows are gone. */
    expect(document.querySelector('[data-row="actual-sales"]')).toBeNull();
    expect(document.querySelector('[data-row="sofa-performance"]')).toBeNull();
    /* The actual bar beside the performance stack; the forecast line only where a period has one. */
    const PERF = 'Performance vs forecast by product group';
    expect(inCard(PERF, '[data-group="actual"]')).toBe(2);
    expect(inCard(PERF, '[data-group="sofa"]')).toBe(2);
    expect(inCard(PERF, '[data-group="bedding"]')).toBe(1);
    expect(inCard(PERF, '[data-point="forecast-sales"]')).toBe(2);
    /* One group: its row alone, with its share; the gaps are that group's. */
    fireEvent.click(screen.getByRole('tab', { name: 'Bedding' }));
    expect(side('perf:bedding')).toEqual([
      '20,000.00 20.0%', '100,000.00 25.0%', '—',
      '0.00 0.0%', '0.00 0.0%', '0.00 0.0%',
      '—', '—', '—',
    ]);
    expect(document.querySelector('[data-row="perf:sofa"]')).toBeNull();
    expect(document.querySelector('[data-row="perf:total"]')).toBeNull();
    expect(cells('actual-vs-forecast')).toEqual(['—', '0.00', '—']);
    expect(inCard(PERF, '[data-group="performance"]')).toBe(1);
    /* Gross profit: the orders against the forecast, the margin in grey; the cost under the total. */
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Gross profit' }));
    expect([...screen.getByLabelText('Performance figures').querySelectorAll('th[data-source]')].map((h) => h.textContent)).toEqual([
      'Performance (SO)', 'Forecast', 'Performance (SO)', 'Forecast', 'Performance (SO)', 'Forecast',
    ]);
    expect(side('perf:sofa')).toEqual(['120,000.00 40.0%', '—', '80,000.00 40.0%', '40,000.00 40.0%', '—', '60,000.00 40.0%']);
    expect(side('perf:total')).toEqual(['160,000.00 40.0%', '—', '80,000.00 40.0%', '48,000.00 40.0%', '—', '60,000.00 40.0%']);
    expect(side('perf:cost')).toEqual(['240,000.00', '—', '120,000.00', '72,000.00', '—', '90,000.00']);
    expect(cells('gp-vs-forecast')).toEqual(['—', '+32,000.00', '—']);
    expect(cells('gp-vs-forecast-pct')).toEqual(['—', '+66.7%', '—']);
    expect(inCard(PERF, '[data-point="forecast-gp"]')).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: 'GP %' }));
    expect(side('perf:total')).toEqual(['40.0%', '—', '40.0%', '40.0%', '—', '40.0%']);
    expect(cells('gp-pct-vs-forecast')).toEqual(['—', '0.0 pp', '—']);
  });

  test('the cost structure: measures switch the figures; a chip takes a group off the chart, never off the table', () => {
    render(<MemoryRouter><FinanceDashboard /></MemoryRouter>);
    expect(cells('bedding')).toEqual(['60,000.00', '0.00', '—']);
    fireEvent.click(screen.getByRole('tab', { name: 'Purchase' }));
    expect(cells('bedding')).toEqual(['8,000.00', '0.00', '—']);
    expect(cells('total')).toEqual(['68,000.00', '0.00', '—']);
    /* Purchase draws the forecast's purchase — the Forecast P&L's cost of sales through the groups' purchase accounts — summed over the groups on the chart (owner 2026-09-22: 做2). */
    const COST = 'Cost structure by product group';
    expect(cells('forecast-purchase')).toEqual(['—', '72,000.00', '90,000.00']);
    expect(inCard(COST, '[data-point="forecast"]')).toBe(2);
    /* The Show pills (owner 2026-09-22: buttons, not ticks): pressed = on the chart; a pill off dims, never leaves the table. */
    const pill = (name: string) => within(screen.getByLabelText(COST)).getByRole('button', { name: `Show ${name}`, pressed: undefined });
    expect(pill('Bedding').getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByLabelText(COST)).queryByRole('button', { name: 'Show all' })).toBeNull();
    fireEvent.click(pill('Bedding'));
    expect(pill('Bedding').getAttribute('aria-pressed')).toBe('false');
    expect(inCard(COST, '[data-group="bedding"]')).toBe(0);
    expect(rowText('bedding')).toContain('8,000.00');
    /* The line follows the pills: Bedding off changes nothing (its forecast is 0); Sofa off too leaves Dining's September alone; Show all brings the total back; Clear empties the chart, line included. */
    expect(cells('forecast-purchase')).toEqual(['—', '72,000.00', '90,000.00']);
    fireEvent.click(pill('Sofa'));
    expect(cells('forecast-purchase')).toEqual(['—', '12,000.00', '—']);
    expect(inCard(COST, '[data-point="forecast"]')).toBe(1);
    fireEvent.click(within(screen.getByLabelText(COST)).getByRole('button', { name: 'Show all' }));
    expect(pill('Bedding').getAttribute('aria-pressed')).toBe('true');
    expect(cells('forecast-purchase')).toEqual(['—', '72,000.00', '90,000.00']);
    fireEvent.click(within(screen.getByLabelText(COST)).getByRole('button', { name: 'Clear' }));
    expect(inCard(COST, '[data-group="sofa"]')).toBe(0);
    expect(inCard(COST, '[data-point="forecast"]')).toBe(0);
    expect(cells('forecast-purchase')).toEqual(['—', '—', '—']);
    expect(within(screen.getByLabelText(COST)).queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(rowText('sofa')).toContain('60,000.00');
    fireEvent.click(within(screen.getByLabelText(COST)).getByRole('button', { name: 'Show all' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Closing stock' }));
    expect(cells('sofa')).toEqual(['10,000.00', '10,000.00', '—']);
  });

  test('the cash flow: In / Out / Net tabs, balances, and the tree\'s categories on Detail', () => {
    render(<MemoryRouter><FinanceDashboard /></MemoryRouter>);
    expect(cells('in')).toEqual(['103,000.00', '50,000.00', '—']);
    expect(cells('closing')).toEqual(['127,000.00', '175,000.00', '—']);
    fireEvent.click(screen.getByRole('tab', { name: 'Out' }));
    expect(document.querySelectorAll('[data-group="out"]').length).toBe(2);
    expect(screen.queryByText('Receipts')).toBeNull();
    fireEvent.click(screen.getByText('Detail'));
    expect(cells('cat:Receipts')).toEqual(['103,000.00', '—', '—']);
  });

  test('the balance sheet and the ratios', () => {
    render(<MemoryRouter><FinanceDashboard /></MemoryRouter>);
    expect(cells('assets')).toEqual(['137,000.00', '137,000.00', '—']);
    expect(cells('equity')).toEqual(['69,000.00', '69,000.00', '—']);
    expect(cells('debt-to-asset')).toEqual(['49.6%', '49.6%', '—']);
    expect(cells('gross-margin')).toEqual(['42.0%', '42.0%', '—']);
    fireEvent.click(screen.getByRole('tab', { name: 'Current Ratio' }));
    expect(cells('current')).toEqual(['2.01', '2.01', '—']);
  });
});
