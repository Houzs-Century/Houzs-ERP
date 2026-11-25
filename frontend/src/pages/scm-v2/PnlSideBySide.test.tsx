/* The Overall P&L's views side by side (owner 2026-11-25: 一张表并排). Pinned:
   one table on the P&L's rows, a column per view named in the address (each
   with its % of its own sales), then the differences — each view less the
   Forecast where it is picked, else Performance less Actual — on every line a
   view names; Performance's own cost line where only it has a figure; the
   range read as its whole months; no Forecast for the months, said, and its
   column left out; a view the reader may not open left out; one view is not
   a table. The replies are made up in the server's own shape. */

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LaidNode } from '../../vendor/scm/lib/report-layout';
import type { PnlViewSide, PnlViewsPayload } from '../../vendor/scm/lib/pnl-views-queries';

const { fetchMock, auth } = vi.hoisted(() => ({
  fetchMock: vi.fn(async (_path: string): Promise<unknown> => ({})),
  auth: { access: new Set<string>() },
}));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (path: string) => fetchMock(path) }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ user: null, can: () => false, pageAccess: (k: string) => (auth.access.has(k) ? 'full' : 'none') }),
}));

import { PnlSideBySideTab, differencesOf, sideBySideColumns } from './PnlSideBySide';

const acct = (code: string, name: string, amountSen: number, base: number): LaidNode =>
  ({ kind: 'account', id: `acc:${code}`, label: `${code} · ${name}`, code, key: code, amountSen, pct: Math.round((amountSen / base) * 1000) / 10, children: [] });
const cat = (id: string, label: string, kids: LaidNode[], base: number): LaidNode => {
  const amountSen = kids.reduce((s, k) => s + k.amountSen, 0);
  return { kind: 'category', id, label, amountSen, pct: Math.round((amountSen / base) * 1000) / 10, children: kids };
};
/** A view: its sales on 500-0001, its cost of sales nodes, one expense, no other income or tax. */
const side = (salesSen: number, cost: LaidNode[], costSen: number, expenseSen: number): PnlViewSide => ({
  layout: {
    baseSen: salesSen,
    tradingIncome: [cat('pl:sales', 'Sales', [acct('500-0001', 'SALES OF BEDDING', salesSen, salesSen)], salesSen)],
    costOfSales: cost,
    otherIncome: [],
    expenses: [cat('pl:general', 'Administrative expense', [acct('900-O001', 'OFFICE EXPENSE', expenseSen, salesSen)], salesSen)],
    taxation: [],
  },
  taxation: [],
  totals: {
    tradingIncomeSen: salesSen, costOfSalesSen: costSen, grossProfitSen: salesSen - costSen, otherIncomeSen: 0,
    expensesSen: expenseSen, profitBeforeTaxSen: salesSen - costSen - expenseSen, taxationSen: 0, netProfitSen: salesSen - costSen - expenseSen,
  },
});
const ORDERS_COST: LaidNode = { kind: 'account', id: 'acc:orders-cost', label: 'Cost of the goods on the orders', amountSen: 600_000_00, pct: 50, children: [] };
const payload = (withForecast: boolean): PnlViewsPayload => ({
  from: '2026-11-01', to: '2026-11-30', months: ['2026-11'],
  actual: side(1_000_000_00, [acct('601-0001', 'PURCHASE OF BEDDING', 550_000_00, 1_000_000_00)], 550_000_00, 100_000_00),
  performance: side(1_200_000_00, [ORDERS_COST], 600_000_00, 100_000_00),
  forecast: withForecast ? side(1_500_000_00, [acct('601-0001', 'PURCHASE OF BEDDING', 750_000_00, 1_500_000_00)], 750_000_00, 120_000_00) : null,
});

const draw = (search: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/scm/accounting?tab=pnlviews${search}`]}>
      <QueryClientProvider client={qc}><PnlSideBySideTab /></QueryClientProvider>
    </MemoryRouter>,
  );
};
const table = () => screen.findByRole('table', { name: 'Overall P&L, views side by side' });
const rowText = (t: HTMLElement, text: string) => within(t).getAllByRole('row').find((r) => r.textContent.includes(text))?.textContent ?? '';
const heads = (t: HTMLElement) => within(t).getAllByRole('columnheader').map((h) => h.textContent);

beforeEach(() => {
  auth.access = new Set(['scm.finance', 'scm.finance.reports', 'scm.finance.forecast']);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => payload(true));
});

describe('the columns', () => {
  test('a view each, then each view less the Forecast where it is picked, else Performance less Actual', () => {
    expect(differencesOf(['actual', 'performance', 'forecast'])).toEqual([['actual', 'forecast'], ['performance', 'forecast']]);
    expect(differencesOf(['actual', 'performance'])).toEqual([['performance', 'actual']]);
    expect(differencesOf(['performance', 'forecast'])).toEqual([['performance', 'forecast']]);
    expect(sideBySideColumns(['actual', 'forecast'], '2026-11-01', '2026-11-30').map((c) => [c.label, c.kind, c.pct])).toEqual([
      ['Actual', 'period', true], ['Forecast', 'period', true], ['Actual − Forecast', 'change', false],
    ]);
  });
});

describe('the table', () => {
  test('three views on the P&L’s rows with their differences; the range read as its whole months', async () => {
    draw('&views=actual,performance,forecast&from=2026-11-01&to=2026-11-25');
    const t = await table();
    expect(fetchMock).toHaveBeenCalledWith('/accounting/reports/pnl-views?from=2026-11-01&to=2026-11-30');
    for (const h of ['Actual', 'Performance', 'Forecast', 'Actual − Forecast', 'Performance − Forecast']) {
      expect(heads(t).some((x) => x.startsWith(h))).toBe(true);
    }
    /* Sales on the same row in every view, then each less the Forecast. */
    const sales = rowText(t, 'SALES OF BEDDING');
    expect(sales).toContain('1,000,000.00');
    expect(sales).toContain('1,200,000.00');
    expect(sales).toContain('1,500,000.00');
    expect(sales).toContain('(500,000.00)');
    expect(sales).toContain('(300,000.00)');
    /* Performance's own cost line: only it has a figure there. */
    const cost = rowText(t, 'Cost of the goods on the orders');
    expect(cost).toContain('600,000.00');
    expect(rowText(t, 'NET PROFIT')).toContain('350,000.00');
    expect(screen.getByText(/Each % is of that view’s own sales/)).toBeTruthy();
  });

  test('Actual and Performance: Performance less Actual', async () => {
    draw('&views=actual,performance&from=2026-11-01&to=2026-11-30');
    const t = await table();
    expect(heads(t).some((h) => h.startsWith('Performance − Actual'))).toBe(true);
    expect(rowText(t, 'SALES OF BEDDING')).toContain('200,000.00');
  });

  test('no Forecast for the months: said, and its column left out', async () => {
    fetchMock.mockImplementation(async () => payload(false));
    draw('&views=actual,forecast&from=2026-11-01&to=2026-11-30');
    expect(await screen.findByText(/No forecast for Nov 2026/)).toBeTruthy();
    const t = await table();
    expect(heads(t).some((h) => h.startsWith('Actual'))).toBe(true);
    expect(heads(t).some((h) => h.startsWith('Forecast') || h.includes('− Forecast'))).toBe(false);
  });

  test('a view the reader may not open is left out; one view is not a table', async () => {
    auth.access = new Set(['scm.finance', 'scm.finance.reports']);
    draw('&views=actual,forecast&from=2026-11-01&to=2026-11-30');
    expect(await screen.findByText('Pick two or three views above to see them side by side.')).toBeTruthy();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
