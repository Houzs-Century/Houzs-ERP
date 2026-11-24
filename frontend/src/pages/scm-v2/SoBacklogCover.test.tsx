/* Finance › Reports › SO conversion & backlog (owner 2026-11-24: the month's
   orders by the Processing Date written on them, the backlog's cover rates on
   the backlog and on the month's processed total, by amount and by number of
   orders, each with an average that starts at the company's first month by
   default and wherever the reader picks). Pinned:
     • the report reads the month picked, and the picker moves it;
     • the tiles give the processed total and each part's amount and share;
     • the backlog at the 1st and the two rates, a row by amount and a row by
       orders, each rate with what it is of and its average;
     • each month's figures, amounts with their order counts, the four rates
       and the averages under them;
     • the average's start is picked in the URL, the default leaving it;
     • a tile narrows the order list to its part and a second press shows them all;
     • an order counted on its first DO, and an AutoCount order, are marked;
     • an order opens in its own tab.
   The figures are made up, in the server's shape (backend/tests/soBacklogCover.test.ts). */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import type { CoverMonth, CoverRow, SoBacklogCoverData } from '../../vendor/scm/lib/so-backlog-cover-queries';

const { fetchMock, openIntent } = vi.hoisted(() => ({ fetchMock: vi.fn(async (_path: string): Promise<unknown> => ({})), openIntent: vi.fn() }));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (path: string) => fetchMock(path) }));
vi.mock('../../lib/workspaceTabs', async (actual) => ({ ...(await actual<typeof import('../../lib/workspaceTabs')>()), markWorkspaceOpenIntent: openIntent }));

import { SoBacklogCoverTab } from './SoBacklogCover';

const row = (docNo: string, soDate: string, processedOn: string, part: CoverRow['part'], amountSen: number, extra: Partial<CoverRow> = {}): CoverRow => ({
  docNo, soDate, processedOn, dateFrom: 'processing_date', customer: `Customer ${docNo}`, imported: false, part, amountSen, ...extra,
});
type Pair = [orders: number, amountSen: number];
type Rates = [onBacklog: number | null, onMonth: number | null];
const cm = (month: string, backlog: Pair, backlogProcessed: Pair, processed: Pair, amount: Rates, orders: Rates): CoverMonth => {
  const c = ([o, a]: Pair) => ({ orders: o, amountSen: a });
  return {
    month, backlog: c(backlog), backlogProcessed: c(backlogProcessed), processed: c(processed),
    amount: { onBacklog: amount[0], onMonth: amount[1] }, orders: { onBacklog: orders[0], onMonth: orders[1] },
  };
};
const SEP_M = cm('2026-09', [4, 2_000_000], [1, 300_000], [2, 666_700], [15, 45], [25, 50]);
const OCT_M = cm('2026-10', [5, 3_000_000], [2, 750_000], [3, 1_000_000], [25, 75], [40, 66.7]);
const OCT: SoBacklogCoverData = {
  month: '2026-10', from: '2026-10-01', to: '2026-10-31',
  total: { orders: 3, amountSen: 1_000_000 },
  parts: { this_month: { orders: 1, amountSen: 250_000, pct: 25 }, backlog: { orders: 2, amountSen: 750_000, pct: 75 } },
  backlog: { orders: 5, amountSen: 3_000_000 },
  cover: { amount: { onBacklog: 25, onMonth: 75 }, orders: { onBacklog: 40, onMonth: 66.7 } },
  average: { from: '2026-09', to: '2026-10', amount: { onBacklog: 20, onMonth: 60 }, orders: { onBacklog: 32.5, onMonth: 58.4 } },
  defaultFrom: '2026-09',
  months: [SEP_M, OCT_M],
  rows: [
    row('HC-SO-T1', '2026-10-01', '2026-10-02', 'this_month', 250_000),
    row('HC-SO-T2', '2026-09-12', '2026-10-09', 'backlog', 450_000),
    row('HC-SO-000777', '2026-03-14', '2026-10-15', 'backlog', 300_000, { dateFrom: 'first_do', imported: true }),
  ],
};
const OCT_FROM_OCT: SoBacklogCoverData = {
  ...OCT, average: { from: '2026-10', to: '2026-10', amount: OCT_M.amount, orders: OCT_M.orders }, months: [OCT_M],
};
const SEP: SoBacklogCoverData = {
  ...OCT, month: '2026-09', from: '2026-09-01', to: '2026-09-30', months: [SEP_M],
  average: { from: '2026-09', to: '2026-09', amount: SEP_M.amount, orders: SEP_M.orders },
  rows: [row('HC-SO-T9', '2026-09-02', '2026-09-03', 'this_month', 120_000)],
};
const nothing = (month: string): SoBacklogCoverData => {
  const none = { orders: 0, amountSen: 0 };
  return {
    month, from: `${month}-01`, to: `${month}-31`, total: none,
    parts: { this_month: { ...none, pct: null }, backlog: { ...none, pct: null } },
    backlog: { orders: 2, amountSen: 1_500_000 },
    cover: { amount: { onBacklog: 0, onMonth: null }, orders: { onBacklog: 0, onMonth: null } },
    average: { from: month, to: month, amount: { onBacklog: 0, onMonth: null }, orders: { onBacklog: 0, onMonth: null } }, defaultFrom: month,
    months: [cm(month, [2, 1_500_000], [0, 0], [0, 0], [0, null], [0, null])], rows: [],
  };
};
fetchMock.mockImplementation(async (path: string) => {
  const q = /\/accounting\/so-backlog-cover\?month=(\d{4}-\d{2})(?:&avgFrom=(\d{4}-\d{2}))?$/.exec(path);
  if (!q) throw new Error(`unexpected ${path}`);
  if (q[1] === '2026-10') return q[2] === '2026-10' ? OCT_FROM_OCT : OCT;
  if (q[1] === '2026-09') return SEP;
  return nothing(q[1]!);
});

function Where() {
  return <output data-testid="search">{useLocation().search}</output>;
}
const draw = (search: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/scm/accounting?${search}`]}>
      <QueryClientProvider client={qc}><SoBacklogCoverTab /><Where /></QueryClientProvider>
    </MemoryRouter>,
  );
};
const OCT_URL = 'tab=sotodo&from=2026-10-01&to=2026-10-31';
const lastPath = () => String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
const tile = (name: RegExp) => screen.getByRole('button', { name });
const tilesOf = (group: string) => [...screen.getByRole('group', { name: group }).children].map((c) => c.textContent);
const amountTiles = () => tilesOf('Backlog cover by amount');
const orderTiles = () => tilesOf('Backlog cover by orders');
const search = () => screen.getByTestId('search').textContent;

describe('SO conversion & backlog', () => {
  test("the month's processed total, and each part's amount and share", async () => {
    draw(OCT_URL);
    await screen.findByText('HC-SO-T1');
    expect(lastPath()).toBe('/accounting/so-backlog-cover?month=2026-10');
    expect(tile(/^Processed in month/).textContent).toBe('Processed in month10,000.003 orders in Oct 2026');
    expect(tile(/^This month's orders/).textContent).toBe("This month's orders2,500.0025.0%1 order");
    expect(tile(/^Backlog orders/).textContent).toBe('Backlog orders7,500.0075.0%2 orders');
    expect(tile(/^Backlog orders/).querySelector('[title="Share of the month\'s processed total"]')?.textContent).toBe('75.0%');
  });

  test('the backlog at the 1st and each cover rate with what it is of and its average: a row by amount, a row by orders', async () => {
    draw(OCT_URL);
    await screen.findByText('HC-SO-T1');
    expect(amountTiles()).toEqual([
      'Backlog at 1 Oct 202630,000.005 orders',
      'Cover rate · on backlog amount25.0%7,500.00 of 30,000.00Average 20.0% · Sep 2026 – Oct 2026',
      'Cover rate · on month amount75.0%7,500.00 of 10,000.00Average 60.0% · Sep 2026 – Oct 2026',
    ]);
    expect(orderTiles()).toEqual([
      'Backlog orders at 1 Oct 20265Not processed by the 1st',
      'Cover rate · on backlog orders40.0%2 of 5 ordersAverage 32.5% · Sep 2026 – Oct 2026',
      'Cover rate · on month orders66.7%2 of 3 ordersAverage 58.4% · Sep 2026 – Oct 2026',
    ]);
  });

  test("each month's backlog with its orders, the four rates, the averages under them", async () => {
    draw(OCT_URL);
    await screen.findByText('HC-SO-T1');
    const table = screen.getByRole('region', { name: 'Backlog cover by month' });
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'Month', 'Backlog at the 1st', 'Backlog processed', 'Processed in month',
      'On backlog · amount', 'On backlog · orders', 'On month · amount', 'On month · orders',
    ]);
    expect([...table.querySelectorAll('tbody tr')].map((tr) => tr.textContent)).toEqual([
      'Sep 202620,000.004 orders3,000.001 order6,667.002 orders15.0%25.0%45.0%50.0%',
      'Oct 202630,000.005 orders7,500.002 orders10,000.003 orders25.0%40.0%75.0%66.7%',
      'Average20.0%32.5%60.0%58.4%',
    ]);
  });

  test('the reader picks where the average starts; the default leaves the URL', async () => {
    draw(OCT_URL);
    await screen.findByText('HC-SO-T1');
    const pick = screen.getByRole('combobox', { name: 'Average from' }) as HTMLSelectElement;
    expect(pick.value).toBe('2026-09');
    fireEvent.change(pick, { target: { value: '2026-10' } });
    await waitFor(() => expect(lastPath()).toBe('/accounting/so-backlog-cover?month=2026-10&avgFrom=2026-10'));
    await waitFor(() => expect(amountTiles()[1]).toContain('Average 25.0% · Oct 2026'));
    expect(orderTiles()[1]).toContain('Average 40.0% · Oct 2026');
    expect(search()).toContain('avg=2026-10');
    fireEvent.change(pick, { target: { value: '2026-09' } });
    await waitFor(() => expect(search()).not.toContain('avg='));
    expect(amountTiles()[1]).toContain('Average 20.0% · Sep 2026 – Oct 2026');
  });

  test('a tile narrows the list to its part, and a second press shows every order again', async () => {
    draw(OCT_URL);
    await screen.findByText('HC-SO-T1');
    fireEvent.click(tile(/^Backlog orders/));
    await waitFor(() => expect(screen.queryByText('HC-SO-T1')).toBeNull());
    expect(screen.getByText('HC-SO-T2')).toBeTruthy();
    expect(tile(/^Backlog orders/).getAttribute('aria-pressed')).toBe('true');
    expect(search()).toContain('part=backlog');
    fireEvent.click(tile(/^Backlog orders/));
    await screen.findByText('HC-SO-T1');
    expect(tile(/^Processed in month/).getAttribute('aria-pressed')).toBe('true');
  });

  test('each order says where it sits; one counted on its first DO and an AutoCount order are marked', async () => {
    draw(OCT_URL);
    await screen.findByText('HC-SO-T1');
    const rowOf = (text: string) => screen.getByText(text).closest('tr')!.textContent;
    expect(rowOf('HC-SO-T1')).toContain('This month');
    expect(rowOf('HC-SO-T2')).toContain('Backlog · Sep 2026');
    expect(rowOf('HC-SO-T2')).not.toContain('First DO');
    expect(rowOf('HC-SO-000777')).toContain('Backlog · Mar 2026');
    expect(rowOf('HC-SO-000777')).toContain('First DO');
    expect(rowOf('HC-SO-000777')).toContain('Imported');
  });

  test('an order opens in its own tab', async () => {
    draw(OCT_URL);
    const link = await screen.findByRole('link', { name: 'HC-SO-T2' });
    expect(link.getAttribute('href')).toBe('/scm/sales-orders/HC-SO-T2');
    fireEvent.click(link, { button: 0 });
    expect(openIntent).toHaveBeenCalledWith(true);
  });

  test('picking another month reads it; an average start after it falls back to the default', async () => {
    draw(`${OCT_URL}&avg=2026-10`);
    await screen.findByText('HC-SO-T1');
    expect(lastPath()).toBe('/accounting/so-backlog-cover?month=2026-10&avgFrom=2026-10');
    fireEvent.change(screen.getByRole('combobox', { name: 'Month' }), { target: { value: '2026-09' } });
    await screen.findByText('HC-SO-T9');
    expect(lastPath()).toBe('/accounting/so-backlog-cover?month=2026-09');
  });

  test('a month with nothing processed says so', async () => {
    draw('tab=sotodo&from=2026-08-01&to=2026-08-31');
    await screen.findByText('No order has a Processing Date in Aug 2026.');
    expect(tile(/^This month's orders/).textContent).toContain('—');
    expect(amountTiles()[2]).toContain('Cover rate · on month amount—');
    expect(orderTiles()[2]).toContain('Cover rate · on month orders—');
  });
});
