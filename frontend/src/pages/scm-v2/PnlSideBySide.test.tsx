/* The Overall P&L's views side by side (owner 2026-11-25: 一张表并排). Pinned:
   one table on the P&L's rows, a column per view named in the address (each
   with its % of its own sales), then the difference — Actual less Forecast —
   on every line a view names; an old link's Performance left out (owner
   2026-11-28: Remove Performance View 的 P&L), its own lines with it; the
   range read as its whole months; no Forecast for the months, said, and its
   column left out; a view the reader may not open left out; one view is not
   a table. By month (the same day: 可以by month 显示两份以上吗？): the Total
   over the months, then each month newest first, each the server's read for
   it, the views and their differences under its name; a month with no
   forecast left blank there and said; the range's newest 12 months at most.
   The replies are made up in the server's own shape. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import { PnlSideBySideTab, differencesOf, monthPeriods, sideBySideColumns } from './PnlSideBySide';

const acct = (code: string, name: string, amountSen: number, base: number): LaidNode =>
  ({ kind: 'account', id: `acc:${code}`, label: `${code} · ${name}`, code, key: code, amountSen, pct: Math.round((amountSen / base) * 1000) / 10, children: [] });
const cat = (id: string, label: string, kids: LaidNode[], base: number): LaidNode => {
  const amountSen = kids.reduce((s, k) => s + k.amountSen, 0);
  return { kind: 'category', id, label, amountSen, pct: Math.round((amountSen / base) * 1000) / 10, children: kids };
};
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
  test('a view each, then Actual less the Forecast where the Forecast is on', () => {
    expect(differencesOf(['actual', 'forecast'])).toEqual([['actual', 'forecast']]);
    expect(differencesOf(['actual'])).toEqual([]);
    expect(sideBySideColumns(['actual', 'forecast'], [{ key: null, label: 'Nov 2026', from: '2026-11-01', to: '2026-11-30' }])
      .map((c) => [c.key, c.label, c.kind, c.pct, c.group?.label ?? null])).toEqual([
      ['actual', 'Actual', 'period', true, null], ['forecast', 'Forecast', 'period', true, null], ['actual-forecast', 'Actual − Forecast', 'change', false, null],
    ]);
  });

  test('by month: the views and their difference under each period’s name, keyed by the period', () => {
    const cols = sideBySideColumns(['actual', 'forecast'], monthPeriods('2026-10-01', '2026-11-30', '2026-12-05'));
    expect(cols.map((c) => [c.key, c.label, c.group?.label])).toEqual([
      ['total:actual', 'Actual', 'Total'], ['total:forecast', 'Forecast', 'Total'], ['total:actual-forecast', 'Actual − Forecast', 'Total'],
      ['2026-11:actual', 'Actual', 'Nov 2026'], ['2026-11:forecast', 'Forecast', 'Nov 2026'], ['2026-11:actual-forecast', 'Actual − Forecast', 'Nov 2026'],
      ['2026-10:actual', 'Actual', 'Oct 2026'], ['2026-10:forecast', 'Forecast', 'Oct 2026'], ['2026-10:actual-forecast', 'Actual − Forecast', 'Oct 2026'],
    ]);
    expect(cols.filter((c) => c.group?.key === '2026-10').map((c) => [c.from, c.to])).toEqual(Array(3).fill(['2026-10-01', '2026-10-31']));
  });
});

describe('by month’s periods', () => {
  test('the Total over the months, then each month newest first; the month still running says to which day', () => {
    expect(monthPeriods('2026-09-01', '2026-11-30', '2026-11-25').map((p) => [p.key, p.label, p.sub ?? '', p.from, p.to])).toEqual([
      ['total', 'Total', '3 months', '2026-09-01', '2026-11-30'],
      ['2026-11', 'Nov 2026', 'to 2026/11/25', '2026-11-01', '2026-11-30'],
      ['2026-10', 'Oct 2026', '', '2026-10-01', '2026-10-31'],
      ['2026-09', 'Sep 2026', '', '2026-09-01', '2026-09-30'],
    ]);
  });

  test('one month is that month alone; a longer range its newest 12 months', () => {
    expect(monthPeriods('2026-10-01', '2026-10-31', '2026-11-25').map((p) => p.key)).toEqual(['2026-10']);
    const long = monthPeriods('2025-10-01', '2026-11-30', '2026-11-25');
    expect(long).toHaveLength(13);
    expect(long[0]).toMatchObject({ key: 'total', sub: '12 months', from: '2025-12-01', to: '2026-11-30' });
    expect(long.at(-1)?.key).toBe('2025-12');
  });
});

describe('the table', () => {
  test('Actual and Forecast on the P&L’s rows with their difference; an old link’s Performance left out; the range read as its whole months', async () => {
    draw('&views=actual,performance,forecast&from=2026-11-01&to=2026-11-25');
    const t = await table();
    expect(fetchMock).toHaveBeenCalledWith('/accounting/reports/pnl-views?from=2026-11-01&to=2026-11-30');
    for (const h of ['Actual', 'Forecast', 'Actual − Forecast']) expect(heads(t).some((x) => x.startsWith(h))).toBe(true);
    expect(heads(t).some((x) => x.includes('Performance'))).toBe(false);
    const sales = rowText(t, 'SALES OF BEDDING');
    expect(sales).toContain('1,000,000.00');
    expect(sales).toContain('1,500,000.00');
    expect(sales).toContain('(500,000.00)');
    expect(sales).not.toContain('1,200,000.00');
    expect(within(t).queryByText('Cost of the goods on the orders')).toBeNull();
    expect(rowText(t, 'NET PROFIT')).toContain('350,000.00');
    expect(screen.getByText(/Each % is of that view’s own sales/)).toBeTruthy();
  });

  test('Actual alone (an old Actual and Performance link) is not a table', async () => {
    draw('&views=actual,performance&from=2026-11-01&to=2026-11-30');
    expect(await screen.findByText('Turn on Actual and Forecast above to see them side by side.')).toBeTruthy();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  test('no Forecast for the months: said, and its column left out', async () => {
    fetchMock.mockImplementation(async () => payload(false));
    draw('&views=actual,forecast&from=2026-11-01&to=2026-11-30');
    expect(await screen.findByText(/No forecast for Nov 2026/)).toBeTruthy();
    const t = await table();
    expect(heads(t).some((h) => h.startsWith('Actual'))).toBe(true);
    expect(heads(t).some((h) => h.startsWith('Forecast') || h.includes('− Forecast'))).toBe(false);
  });

  test('the Show switch reads the table month by month', async () => {
    draw('&views=actual,forecast&from=2026-09-01&to=2026-11-30');
    await table();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/accounting/reports/pnl-views?from=2026-09-01&to=2026-09-30'));
    expect(screen.getByRole('button', { name: 'By month' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('a view the reader may not open is left out; one view is not a table', async () => {
    auth.access = new Set(['scm.finance', 'scm.finance.reports']);
    draw('&views=actual,forecast&from=2026-11-01&to=2026-11-30');
    expect(await screen.findByText('Turn on Actual and Forecast above to see them side by side.')).toBeTruthy();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});

describe('by month', () => {
  const reply = (actualSen: number, perfSen: number, forecastSen: number | null): PnlViewsPayload => ({
    from: '', to: '', months: [],
    actual: side(actualSen, [acct('601-0001', 'PURCHASE OF BEDDING', actualSen / 2, actualSen)], actualSen / 2, 0),
    performance: side(perfSen, [{ ...ORDERS_COST, amountSen: perfSen / 2 }], perfSen / 2, 0),
    forecast: forecastSen === null ? null : side(forecastSen, [acct('601-0001', 'PURCHASE OF BEDDING', forecastSen / 2, forecastSen)], forecastSen / 2, 0),
  });
  const PATH = (from: string, to: string) => `/accounting/reports/pnl-views?from=${from}&to=${to}`;
  const BY_PATH: Record<string, PnlViewsPayload> = {
    [PATH('2026-09-01', '2026-11-30')]: reply(600_000_00, 710_000_00, 610_000_00),
    [PATH('2026-11-01', '2026-11-30')]: reply(300_000_00, 330_000_00, 360_000_00),
    [PATH('2026-10-01', '2026-10-31')]: reply(200_000_00, 260_000_00, 250_000_00),
    [PATH('2026-09-01', '2026-09-30')]: reply(100_000_00, 120_000_00, null),
  };
  const amounts = (t: HTMLElement, text: string) => {
    const row = within(t).getAllByRole('row').find((r) => r.textContent.includes(text))!;
    return within(row).getAllByRole('cell').map((td) => td.textContent.replace(td.querySelector('[data-pct]')?.textContent ?? '', ''));
  };
  const headings = (t: HTMLElement) => within(t).getAllByRole('columnheader').filter((h) => h.getAttribute('scope') === 'colgroup').map((h) => h.textContent);

  beforeEach(() => {
    fetchMock.mockImplementation(async (path: string) => BY_PATH[path] ?? payload(true));
  });

  test('the Total, then each month newest first, each its own read: the views and their difference under its name', async () => {
    draw('&views=actual,forecast&from=2026-09-01&to=2026-11-25&by=month');
    const t = await table();
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(Object.keys(BY_PATH).sort());
    expect(headings(t)).toEqual([
      expect.stringMatching(/^Total3 months/), expect.stringMatching(/^Nov 2026/), expect.stringMatching(/^Oct 2026/), expect.stringMatching(/^Sep 2026/),
    ]);
    expect(within(t).queryByText('Cost of the goods on the orders')).toBeNull();
    expect(screen.getByText(/By month: the Total over the months, then each month, newest first/)).toBeTruthy();
  });

  test('a month with no forecast: its Forecast and differences blank, and said', async () => {
    draw('&views=actual,forecast&from=2026-09-01&to=2026-11-30&by=month');
    expect(await screen.findByText('No forecast for Sep 2026 — the Forecast P&L has none for that month.')).toBeTruthy();
    const t = await table();
    expect(amounts(t, 'SALES OF BEDDING')).toEqual([
      '600,000.00', '610,000.00', '(10,000.00)',
      '300,000.00', '360,000.00', '(60,000.00)',
      '200,000.00', '250,000.00', '(50,000.00)',
      '100,000.00', '', '',
    ]);
  });
});
