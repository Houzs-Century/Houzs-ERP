/* Finance › Reports › Product changes and Product changes P&L (owner 2026-11-23:
   「我主要是看销售价和成本的变动，因为我要确定这些改动销售价是足够cover成本的变动」,
   「那个变动的报表我要可以选择月份去看哦」, the summary 「类似 p&L」). Pinned:
     • the detail reads the month picked, and the picker moves it;
     • the two buckets and "Not covered only" filter the rows, in the URL;
     • each row shows selling, cost and margin before → after with the change,
       and the not-covered flag with its shortfall;
     • the summary adds the months up P&L-style with a Total, then by salesperson,
       the largest shortfall first.
   The rows are made up, in the server's shape (backend/tests/productChanges.test.ts). */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import type { ChangedLine, ProductChangeRow, ProductChangeType } from '../../vendor/scm/lib/product-change-queries';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn(async (_path: string): Promise<unknown> => ({})) }));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (path: string) => fetchMock(path) }));

import { ProductChangesSummaryTab, ProductChangesTab } from './ProductChanges';

let seq = 0;
const side = (code: string, qty: number, sellingSen: number, costSen: number) => ({ code, qty, sellingSen, costSen });
function ev(day: string, seller: string, types: ProductChangeType[], sb: number, sa: number, cb: number, ca: number, lines: ChangedLine[], extra: Partial<ProductChangeRow> = {}): ProductChangeRow {
  const sd = sa - sb; const cd = ca - cb; const md = sd - cd;
  seq += 1;
  return {
    id: `e${seq}`, docNo: `HC-SO-T${seq}`, soDate: '2026-09-02', customer: `Customer ${seq}`, salesperson: seller, changeDay: day, changedAt: null,
    route: 'DIRECT', amendmentNos: [], changedBy: [seller], approvedBy: [], types, bucket: sd !== 0 ? 'SELLING' : 'COST_ONLY',
    sellingBeforeSen: sb, sellingAfterSen: sa, costBeforeSen: cb, costAfterSen: ca, sellingDeltaSen: sd, costDeltaSen: cd, marginDeltaSen: md,
    covered: md >= 0, shortfallSen: Math.max(0, -md), lines, ...extra,
  };
}
const ROWS: ProductChangeRow[] = [
  ev('2026-09-04', 'Aina', ['sku'], 459900, 529900, 182000, 214000, [{ id: 'l1', types: ['sku'], before: side('PLUSH-(Q)', 1, 459900, 182000), after: side('PLUSH-(K)', 1, 529900, 214000) }]),
  ev('2026-10-03', 'Aina', ['qty'], 120000, 240000, 40000, 82000, [{ id: 'l2', types: ['qty'], before: side('PILLOW-STD', 1, 120000, 40000), after: side('PILLOW-STD', 2, 240000, 82000) }]),
  ev('2026-10-17', 'Chandra', ['sku', 'new_line'], 900000, 780000, 360000, 352000, [
    { id: 'l3', types: ['sku'], before: side('CODY-(K)', 1, 300000, 120000), after: side('CODY-(Q)', 1, 260000, 104000) },
    { id: 'l4', types: ['new_line'], before: null, after: side('SIDE-TABLE', 1, 0, 8000) },
  ], { route: 'AMENDMENT', amendmentNos: ['HC-SO-T3/A1', 'HC-SO-T3/A2'], approvedBy: ['Kris'] }),
  ev('2026-10-28', 'Ben', ['height'], 520000, 520000, 210000, 222000, [{ id: 'l5', types: ['height'], before: side('9028-2A(LHF)', 1, 520000, 210000), after: side('9028-2A(LHF)', 1, 520000, 222000) }]),
  ev('2026-11-11', 'Aina', ['sku'], 610000, 549000, 230000, 233500, [{ id: 'l6', types: ['sku'], before: side('ULTRA-(K)', 1, 610000, 230000), after: side('ULTRA-FIRM-(K)', 1, 549000, 233500) }]),
];
const monthEnd = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).toISOString().slice(0, 10);
fetchMock.mockImplementation(async (path: string) => {
  const q = /\/accounting\/product-changes\?from=(\d{4}-\d{2})&to=(\d{4}-\d{2})/.exec(path);
  if (!q) throw new Error(`unexpected ${path}`);
  const [, from, to] = q as unknown as [string, string, string];
  return { month: from, from: `${from}-01`, to: monthEnd(to), rows: ROWS.filter((r) => r.changeDay.slice(0, 7) >= from && r.changeDay.slice(0, 7) <= to) };
});

const draw = (ui: 'detail' | 'summary', search: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/scm/accounting?${search}`]}>
      <QueryClientProvider client={qc}>{ui === 'detail' ? <ProductChangesTab /> : <ProductChangesSummaryTab />}</QueryClientProvider>
    </MemoryRouter>,
  );
};
const rowOf = (text: string) => screen.getAllByText(text)[0]!.closest('tr')!;
const lastPath = () => String(fetchMock.mock.calls.at(-1)?.[0] ?? '');

describe('Product changes, by month', () => {
  test("the month's changes with selling, cost and margin before → after, and the ones not covered", async () => {
    draw('detail', 'tab=changes&from=2026-10-01&to=2026-10-31');
    await screen.findByText('HC-SO-T3');
    expect(lastPath()).toBe('/accounting/product-changes?from=2026-10&to=2026-10');
    expect(screen.queryByText('HC-SO-T1')).toBeNull();
    const t3 = rowOf('HC-SO-T3').textContent;
    expect(t3).toContain('9,000.00 → 7,800.00');
    expect(t3).toContain('(1,200.00)');
    expect(t3).toContain('Not covered · 1,120.00');
    expect(t3).toContain('Amendment A1 + A2');
    expect(rowOf('HC-SO-T2').textContent).toContain('Covered');
  });

  test('the buckets and "Not covered only" filter the rows', async () => {
    draw('detail', 'tab=changes&from=2026-10-01&to=2026-10-31');
    await screen.findByText('HC-SO-T3');
    fireEvent.click(screen.getByRole('button', { name: 'Selling same, cost changed' }));
    await waitFor(() => expect(screen.queryByText('HC-SO-T3')).toBeNull());
    expect(screen.getByText('HC-SO-T4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All changes' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Not covered only' }));
    await waitFor(() => expect(screen.queryByText('HC-SO-T2')).toBeNull());
    expect(screen.getByText('HC-SO-T3')).toBeTruthy();
  });

  test('picking another month reads it', async () => {
    draw('detail', 'tab=changes&from=2026-10-01&to=2026-10-31');
    await screen.findByText('HC-SO-T3');
    fireEvent.change(screen.getByRole('combobox', { name: 'Month' }), { target: { value: '2026-09' } });
    await screen.findByText('HC-SO-T1');
    expect(lastPath()).toBe('/accounting/product-changes?from=2026-09&to=2026-09');
  });
});

describe('Product changes P&L', () => {
  test('each month and the total, P&L-style, then by salesperson with the largest shortfall first', async () => {
    draw('summary', 'tab=changesum&from=2026-09-01&to=2026-11-30');
    const pnl = await screen.findByRole('region', { name: 'Product changes by month' });
    expect(lastPath()).toBe('/accounting/product-changes?from=2026-09&to=2026-11');
    const head = within(pnl).getAllByRole('columnheader').map((h) => h.textContent);
    expect(head.slice(1)).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026', 'Total']);
    const shortfalls = within(pnl).getAllByText('Shortfall').map((c) => c.closest('tr')!.textContent);
    expect(shortfalls[0]).toBe('Shortfall—1,120.00645.001,765.00');
    const people = await screen.findByRole('region', { name: 'By salesperson' });
    await waitFor(() => expect(within(people).getAllByRole('row').length).toBeGreaterThan(1));
    const names = within(people).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(names[0]).toContain('Chandra');
  });
});
