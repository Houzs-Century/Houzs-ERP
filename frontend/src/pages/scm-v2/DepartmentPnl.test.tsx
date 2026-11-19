/* The Department P&L tab (owner 2026-11-19: an Operation report = his "Operation
   PNL - Auto" sheet, a G&A report, and 「我要可以看全部的，也要可以看单独部门的」).
   The replies are the real handlers' own over a made-up two-month world
   (DepartmentPnl.fixture.json; the server half is backend/tests/departmentPnl.test.ts).
   Pinned:
     • All departments: G&A | Operation | Logistics | Not in a department | Total, a
       payroll account split by its team lines, the Total the P&L's figure;
     • G&A: the share of the Performance sales, the HQ teams under Salary & related,
       the surplus; its rate saved;
     • Operation: the owner's sheet by region with a % of DO beside; the rows in his
       words; the warehouse insurance spread, its months saved;
     • the department switch lives in the URL. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import fixture from './DepartmentPnl.fixture.json';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => ({ ok: true })),
}));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: (path: string, init?: RequestInit) => fetchMock(path, init),
}));

import { DepartmentPnlTab } from './DepartmentPnl';

fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'PUT') return { ok: true };
  const view = /\/acc-events\/departments\/(all|ga|operation)\?/.exec(path)?.[1] as 'all' | 'ga' | 'operation' | undefined;
  if (!view) throw new Error(`unexpected ${path}`);
  return (fixture as Record<string, unknown>)[view];
});
const draw = (search = '') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/scm/accounting?tab=departments&from=2026-09-01&to=2026-10-31${search}`]}>
      <QueryClientProvider client={qc}><DepartmentPnlTab /></QueryClientProvider>
    </MemoryRouter>,
  );
};
const putOf = (path: string) => fetchMock.mock.calls.filter(([p, i]) => p === path && i?.method === 'PUT').map(([, i]) => JSON.parse(String(i!.body)));
const rowText = (table: HTMLElement, label: string) => within(table).getAllByText(label)[0]!.closest('tr')!.textContent;

describe('All departments', () => {
  test('every account split across the departments, the Total the P&L', async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Department P&L, all departments' });
    for (const h of ['G&A', 'Operation', 'Logistics', 'Not in a department', 'Total']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    /* Staff salaries: G&A's teams 53,400, the warehouse teams 81,600, drivers and helpers 81,000 — the P&L's 216,000. */
    expect(rowText(table, '900-S100 · STAFF SALARIES & OVERTIME')).toBe('900-S100 · STAFF SALARIES & OVERTIME53,400.0081,600.0081,000.00-216,000.00');
    expect(rowText(table, '599-0000 · ADDITIONAL INCOME')).toContain('14,000.00');
    expect(rowText(table, 'NET PROFIT / (LOSS)')).toContain('394,040.00');
    expect(screen.getByText('G&A expenses')).toBeTruthy();
  });

  test('the department switch lives in the URL', async () => {
    draw();
    await screen.findByRole('table', { name: 'Department P&L, all departments' });
    fireEvent.click(screen.getByRole('button', { name: 'Operation' }));
    expect(await screen.findByRole('table', { name: 'Department P&L, Operation' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/acc-events/departments/operation?from=2026-09-01&to=2026-10-31'))).toBe(true);
  });
});

describe('G&A', () => {
  test('its share of the Performance sales against what it booked; the HQ teams; the surplus; the rate saved', async () => {
    draw('&dv=ga');
    const table = await screen.findByRole('table', { name: 'Department P&L, G&A' });
    expect(rowText(table, 'Performance sales')).toContain('4,300,000.00');
    expect(rowText(table, 'G&A share (8% of Performance sales)')).toContain('344,000.00');
    expect(within(table).getByText('Finance team · salary, EPF, SOCSO, EIS, allowance')).toBeTruthy();
    expect(rowText(table, 'SURPLUS / (DEFICIT)')).toContain('229,400.00');
    fireEvent.change(screen.getByLabelText('G&A share percent'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putOf('/acc-events/departments/rate')).toEqual([{ dept: 'ga', pct: 10 }]));
  });

  test('by month: a Total, then one column per month', async () => {
    draw('&dv=ga&dm=months');
    const table = await screen.findByRole('table', { name: 'Department P&L, G&A' });
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads[1]).toMatch(/^Total/);
    expect(heads.slice(2).map((h) => h.replace(/%$/, ''))).toEqual(expect.arrayContaining([expect.stringMatching(/Sep/), expect.stringMatching(/Oct/)]));
  });
});

describe('Operation', () => {
  test("the owner's sheet by region, a % of DO beside; the fairs said when unread; the insurance spread saved", async () => {
    draw('&dv=operation');
    const table = await screen.findByRole('table', { name: 'Department P&L, Operation' });
    for (const h of ['Penang', 'KL', 'SBH & SWK', 'Total']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    expect(rowText(table, '7% Income from Delivery Order')).toContain('59,500.007.0%');
    expect(rowText(table, 'Income:- 2990 income')).toContain('18,000.00');
    expect(rowText(table, 'Warehouse Manpower - Storekeeper')).toContain('21,600.00');
    expect(rowText(table, 'Rental Warehouse')).toContain('96,600.00');
    expect(rowText(table, 'Net Profit / (Loss) After Logistics & Setup/Dismantle')).toContain('(14,860.00)');
    expect(screen.getByText(/The fairs could not be read/)).toBeTruthy();
    const spreads = screen.getByRole('table', { name: 'Warehouse upkeep and insurance spread' });
    const months = within(spreads).getByRole('spinbutton');
    expect((months as HTMLInputElement).value).toBe('12');
    fireEvent.change(months, { target: { value: '6' } });
    fireEvent.click(within(spreads).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putOf('/acc-events/logistics/spread')).toEqual([{ lineId: expect.any(String), months: 6 }]));
  });
});
