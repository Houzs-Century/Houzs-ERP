/* Finance › Reports › SO to DO conversion (owner 2026-11-24: "how much of this
   month's orders went to DO, everything else counts as earlier", with a month
   to pick and the total amount and percentage). Pinned:
     • the report reads the month picked, and the picker moves it;
     • the tiles give the month's total and each part's amount and share;
     • a tile narrows the DO list to its part, in the URL, and a second press
       shows every DO again;
     • each DO says where its order sits, an AutoCount order marked Imported;
     • Other DOs shows only when the month has one;
     • a DO and its order each open in their own tab.
   The figures are made up, in the server's shape (backend/tests/soDoConversion.test.ts). */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import type { ConversionRow, SoDoConversionData } from '../../vendor/scm/lib/so-do-conversion-queries';

const { fetchMock, openIntent } = vi.hoisted(() => ({ fetchMock: vi.fn(async (_path: string): Promise<unknown> => ({})), openIntent: vi.fn() }));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (path: string) => fetchMock(path) }));
vi.mock('../../lib/workspaceTabs', async (actual) => ({ ...(await actual<typeof import('../../lib/workspaceTabs')>()), markWorkspaceOpenIntent: openIntent }));

import { SoDoConversionTab } from './SoDoConversion';

const row = (id: string, doDate: string, docNo: string | null, soDate: string | null, part: ConversionRow['part'], amountSen: number, extra: Partial<ConversionRow> = {}): ConversionRow => ({
  id, doNumber: `DO-${id}`, doDate, status: 'DELIVERED', docNo, soDate, customer: docNo ? `Customer ${docNo}` : null, imported: false,
  part, otherReason: null, amountSen, ...extra,
});

const OCT: SoDoConversionData = {
  month: '2026-10', from: '2026-10-01', to: '2026-10-31',
  total: { dos: 4, amountSen: 1_000_000, pct: 100 },
  parts: {
    this_month: { dos: 1, amountSen: 250_000, pct: 25 },
    earlier: { dos: 2, amountSen: 700_000, pct: 70 },
    other: { dos: 1, amountSen: 50_000, pct: 5 },
  },
  rows: [
    row('u1', '2026-10-03', 'HC-SO-T1', '2026-10-01', 'this_month', 250_000),
    row('u2', '2026-10-09', 'HC-SO-T2', '2026-09-12', 'earlier', 400_000),
    row('u3', '2026-10-15', 'HC-SO-000777', '2026-03-14', 'earlier', 300_000, { imported: true }),
    row('u4', '2026-10-20', null, null, 'other', 50_000, { otherReason: 'no_order' }),
  ],
};
const SEP: SoDoConversionData = {
  month: '2026-09', from: '2026-09-01', to: '2026-09-30',
  total: { dos: 1, amountSen: 120_000, pct: 100 },
  parts: {
    this_month: { dos: 1, amountSen: 120_000, pct: 100 },
    earlier: { dos: 0, amountSen: 0, pct: 0 },
    other: { dos: 0, amountSen: 0, pct: 0 },
  },
  rows: [row('s1', '2026-09-20', 'HC-SO-T9', '2026-09-02', 'this_month', 120_000)],
};
fetchMock.mockImplementation(async (path: string) => {
  const q = /\/accounting\/so-do-conversion\?month=(\d{4}-\d{2})$/.exec(path);
  if (!q) throw new Error(`unexpected ${path}`);
  if (q[1] === '2026-10') return OCT;
  if (q[1] === '2026-09') return SEP;
  const none = { dos: 0, amountSen: 0, pct: null };
  return { month: q[1], from: `${q[1]}-01`, to: `${q[1]}-31`, total: none, parts: { this_month: none, earlier: none, other: none }, rows: [] };
});

const draw = (search: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/scm/accounting?${search}`]}>
      <QueryClientProvider client={qc}><SoDoConversionTab /></QueryClientProvider>
    </MemoryRouter>,
  );
};
const lastPath = () => String(fetchMock.mock.calls.at(-1)?.[0] ?? '');
const tile = (name: RegExp) => screen.getByRole('button', { name });

describe('SO to DO conversion', () => {
  test("the month's total, and the amount and share from this month's orders and from earlier ones", async () => {
    draw('tab=sotodo&from=2026-10-01&to=2026-10-31');
    await screen.findByText('DO-u1');
    expect(lastPath()).toBe('/accounting/so-do-conversion?month=2026-10');
    expect(tile(/^Total amount/).textContent).toBe('Total amount10,000.004 DOs in Oct 2026');
    expect(tile(/^This month's orders/).textContent).toBe("This month's orders2,500.0025.0% of the total · 1 DO");
    expect(tile(/^Earlier orders/).textContent).toBe('Earlier orders7,000.0070.0% of the total · 2 DOs');
    expect(tile(/^Other DOs/).textContent).toBe('Other DOs500.005.0% of the total · 1 DO');
  });

  test('a tile narrows the list to its part, and a second press shows every DO again', async () => {
    draw('tab=sotodo&from=2026-10-01&to=2026-10-31');
    await screen.findByText('DO-u1');
    fireEvent.click(tile(/^Earlier orders/));
    await waitFor(() => expect(screen.queryByText('DO-u1')).toBeNull());
    expect(screen.getByText('DO-u2')).toBeTruthy();
    expect(screen.getByText('DO-u3')).toBeTruthy();
    expect(tile(/^Earlier orders/).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tile(/^Earlier orders/));
    await screen.findByText('DO-u1');
    expect(tile(/^Total amount/).getAttribute('aria-pressed')).toBe('true');
  });

  test("each DO says where its order sits; an AutoCount order is marked Imported", async () => {
    draw('tab=sotodo&from=2026-10-01&to=2026-10-31');
    await screen.findByText('DO-u1');
    const rowOf = (text: string) => screen.getByText(text).closest('tr')!.textContent;
    expect(rowOf('DO-u1')).toContain('This month');
    expect(rowOf('DO-u2')).toContain('Earlier · Sep 2026');
    expect(rowOf('DO-u3')).toContain('Earlier · Mar 2026');
    expect(rowOf('DO-u3')).toContain('Imported');
    expect(rowOf('DO-u2')).not.toContain('Imported');
    expect(rowOf('DO-u4')).toContain('No sales order');
  });

  test('a DO and its order open in their own tab', async () => {
    draw('tab=sotodo&from=2026-10-01&to=2026-10-31');
    const doLink = await screen.findByRole('link', { name: 'DO-u2' });
    expect(doLink.getAttribute('href')).toBe('/scm/delivery-orders/u2');
    expect(screen.getByRole('link', { name: 'HC-SO-T2' }).getAttribute('href')).toBe('/scm/sales-orders/HC-SO-T2');
    fireEvent.click(doLink, { button: 0 });
    expect(openIntent).toHaveBeenCalledWith(true);
  });

  test('picking another month reads it; Other DOs shows only when the month has one', async () => {
    draw('tab=sotodo&from=2026-10-01&to=2026-10-31');
    await screen.findByText('DO-u1');
    fireEvent.change(screen.getByRole('combobox', { name: 'Month' }), { target: { value: '2026-09' } });
    await screen.findByText('DO-s1');
    expect(lastPath()).toBe('/accounting/so-do-conversion?month=2026-09');
    expect(tile(/^This month's orders/).textContent).toContain('100.0% of the total');
    expect(screen.queryByRole('button', { name: /^Other DOs/ })).toBeNull();
  });

  test('a month with no shipped DO says so', async () => {
    draw('tab=sotodo&from=2026-08-01&to=2026-08-31');
    await screen.findByText('No shipped delivery order is dated in Aug 2026.');
    expect(tile(/^This month's orders/).textContent).toContain('—');
  });
});
