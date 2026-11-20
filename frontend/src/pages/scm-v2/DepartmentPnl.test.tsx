/* The Department P&L tab (owner 2026-11-19: an Operation report = his "Operation
   PNL - Auto" sheet, a G&A report, and 「我要可以看全部的，也要可以看单独部门的」).
   The replies are the real handlers' own over a made-up two-month world
   (DepartmentPnl.fixture.json; the server half is backend/tests/departmentPnl.test.ts).
   Pinned:
     • the company's own departments (Houzs: Exhibition, Operation, Logistics, G&A):
       All splits every line across them with no "not in a department" column, the
       switch offers each one that has a view (Logistics is its own report);
     • All: a payroll account split by its team lines, a job ad by its post, the
       showroom folded into G&A, the Total the P&L's figure;
     • Exhibition: the fairs' sales less their cost and what Exhibition booked;
     • G&A: the share of the Performance sales, the HQ teams under Salary & related,
       the surplus; its rate saved;
     • Operation: the owner's sheet by region with a % of DO beside; the rows in his
       words; the warehouse insurance spread, its months saved;
     • the department switch lives in the URL;
     • a figure opens the lines behind it (owner 2026-11-20: 「我希望这里点开也能看」):
       the Operation sheet's from the report (the fixture's `lines`, derived from its
       own rows and lists so that each row is its lines added up), totalled to the
       figure; All, Exhibition and G&A read theirs for the figure's column; the
       results that add up rows open nothing. */

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

/* What a figure of All, Exhibition or G&A reads when opened: made-up lines. */
const LINES = {
  lines: [
    { id: 'g1', month: '2026-09', day: '2026-09-30', accountCode: '900-S100', accountName: 'STAFF SALARIES & OVERTIME', ref: 'JE-1', text: 'FINANCE - SALARY - SEP2026', dept: 'ga', team: 'FINANCE', sen: 820_000, source: 'ledger' },
    { id: 'g2', month: '2026-10', day: '2026-10-31', accountCode: '900-S100', accountName: 'STAFF SALARIES & OVERTIME', ref: 'JE-2', text: 'FINANCE - SALARY - OCT2026', dept: 'ga', team: 'FINANCE', sen: 820_000, source: 'ledger' },
  ],
  totalSen: 1_640_000,
};
fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'PUT') return { ok: true };
  if (path === '/acc-events/departments/plan') return fixture.plan;
  if (path.startsWith('/acc-events/departments/lines?')) return LINES;
  if (path.startsWith('/acc-events/departments/dept?d=exhibition&')) return fixture.exhibition;
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
  test("every account split across the company's departments, the Total the P&L, no column for none", async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Department P&L, all departments' });
    for (const h of ['Exhibition', 'Operation', 'Logistics', 'G&A', 'Total']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    expect(within(table).queryByText('Not in a department')).toBeNull();
    /* Staff salaries: the warehouse teams 81,600, drivers and helpers 81,000, G&A's teams 53,400 — the P&L's 216,000. */
    expect(rowText(table, '900-S100 · STAFF SALARIES & OVERTIME')).toBe('900-S100 · STAFF SALARIES & OVERTIME-81,600.0081,000.0053,400.00216,000.00');
    /* Houzs's showroom counts in G&A; the warehouse job ad in Operation, the account executive's in G&A. */
    expect(rowText(table, '900-R009 · SHOW ROOM (KELANA JAYA)')).toBe('900-R009 · SHOW ROOM (KELANA JAYA)---44,000.0044,000.00');
    expect(rowText(table, '900-A004 · ADVERTISEMENT - MANAGEMENT FEES')).toBe('900-A004 · ADVERTISEMENT - MANAGEMENT FEES-1,271.90-514.161,786.06');
    expect(rowText(table, 'NET PROFIT / (LOSS)')).toContain('392,253.94');
    expect(screen.getByText('Exhibition expenses')).toBeTruthy();
  });

  test('the switch offers the company\'s departments that have a view — no Logistics, no link out — and lives in the URL', async () => {
    draw();
    await screen.findByRole('table', { name: 'Department P&L, all departments' });
    const group = screen.getByRole('group', { name: 'Department' });
    await waitFor(() => expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All departments', 'Exhibition', 'Operation', 'G&A']));
    expect(screen.queryByText('Logistics cost report')).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Operation' }));
    expect(await screen.findByRole('table', { name: 'Department P&L, Operation' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/acc-events/departments/operation?from=2026-09-01&to=2026-10-31'))).toBe(true);
  });
});

describe('Exhibition', () => {
  test("the Exhibition P&L: the fairs' sales less their cost and what Exhibition booked", async () => {
    draw('&dv=exhibition');
    const table = await screen.findByRole('table', { name: 'Department P&L, Exhibition' });
    expect(rowText(table, 'Total sales')).toContain('4,180,000.00');
    expect(rowText(table, 'GROSS PROFIT')).toContain('2,200,000.00');
    expect(rowText(table, 'EXHIBITION PROFIT / (LOSS)')).toContain('968,000.00');
    expect(within(table).getByText('900-R032 · RENTAL - EXHIBITION')).toBeTruthy();
  });
});

describe('G&A', () => {
  test('its share of the Performance sales against what it booked; the HQ teams; the surplus; the rate saved', async () => {
    draw('&dv=ga');
    const table = await screen.findByRole('table', { name: 'Department P&L, G&A' });
    expect(rowText(table, 'Performance sales')).toContain('4,300,000.00');
    expect(rowText(table, 'G&A share (8% of Performance sales)')).toContain('344,000.00');
    expect(within(table).getByText('Finance team · salary, EPF, SOCSO, EIS, allowance')).toBeTruthy();
    expect(rowText(table, 'SURPLUS / (DEFICIT)')).toContain('90,885.84');
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
    expect(rowText(table, 'Recruitment (job ads)')).toContain('1,271.90');
    expect(rowText(table, 'Net Profit / (Loss) After Logistics & Setup/Dismantle')).toContain('(16,131.90)');
    expect(screen.getByText(/The fairs could not be read/)).toBeTruthy();
    const spreads = screen.getByRole('table', { name: 'Warehouse upkeep and insurance spread' });
    const months = within(spreads).getByRole('spinbutton');
    expect((months as HTMLInputElement).value).toBe('12');
    fireEvent.change(months, { target: { value: '6' } });
    fireEvent.click(within(spreads).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putOf('/acc-events/logistics/spread')).toEqual([{ lineId: expect.any(String), months: 6 }]));
  });
});

describe('A figure opens the lines behind it', () => {
  const linesAsked = () => fetchMock.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/acc-events/departments/lines?')).map((p) => Object.fromEntries(new URLSearchParams(p.split('?')[1])));
  const rowOf = (table: HTMLElement, label: string) => within(table).getAllByText(label)[0]!.closest('tr')!;

  test("Operation: a row's figure opens its lines in that column, totalled to the figure; the results open nothing", async () => {
    draw('&dv=operation');
    const table = await screen.findByRole('table', { name: 'Department P&L, Operation' });
    /* Rental Warehouse in KL over Sep and Oct: two ledger lines of 27,500.00. */
    fireEvent.click(within(rowOf(table, 'Rental Warehouse')).getByRole('button', { name: '55,000.00' }));
    const rental = await screen.findByRole('region', { name: 'Lines of Rental Warehouse' });
    expect(within(rental).getByText(/Sep 2026 – Oct 2026 · KL · 2 lines/)).toBeTruthy();
    expect(within(rental).getAllByText('27,500.00')).toHaveLength(2);
    expect(within(rental).getByText('55,000.00')).toBeTruthy();
    expect(within(rental).getByRole('link', { name: /Open in General ledger/ }).getAttribute('href')).toContain('accounts=900-R005');
    fireEvent.click(within(rental).getByRole('button', { name: 'Close the lines' }));
    expect(screen.queryByRole('region', { name: 'Lines of Rental Warehouse' })).toBeNull();
    /* A salary line naming no region: its KL share, the whole line said. */
    fireEvent.click(within(rowOf(table, 'Warehouse Manpower - Logistic')).getByRole('button', { name: '14,534.17' }));
    const pay = await screen.findByRole('region', { name: 'Lines of Warehouse Manpower - Logistic' });
    expect(within(pay).getAllByText('DO-value share of the line 10,000.00')).toHaveLength(2);
    expect(within(pay).getByText('14,534.17')).toBeTruthy();
    /* What only adds up the rows above opens nothing. */
    for (const label of ['Gross Profit / (Loss)', 'Net Profit / (Loss)', 'Net Profit / (Loss) After Logistics & Setup/Dismantle']) {
      expect(within(rowOf(table, label)).queryAllByRole('button')).toHaveLength(0);
    }
    /* The 7% income opens how it was worked out. */
    fireEvent.click(within(rowOf(table, '7% Income from Delivery Order')).getAllByRole('button')[0]!);
    const income = await screen.findByRole('region', { name: 'Lines of 7% Income from Delivery Order' });
    expect(within(income).getByText('7% of the DO value 450,000.00')).toBeTruthy();
  });

  test("Operation: Total Warehouse Expenses opens every warehouse line, each with its row", async () => {
    draw('&dv=operation');
    const table = await screen.findByRole('table', { name: 'Department P&L, Operation' });
    fireEvent.click(within(rowOf(table, 'Total Warehouse Expenses')).getByRole('button', { name: '198,631.90' }));
    const all = await screen.findByRole('region', { name: 'Lines of Total Warehouse Expenses' });
    expect(within(all).getByRole('columnheader', { name: /Row/ })).toBeTruthy();
    expect(within(all).getAllByText('Insurance Warehouse').length).toBeGreaterThan(0);
    expect(within(all).getByText('198,631.90')).toBeTruthy();
  });

  test("G&A: an expense reads its lines for the column's months; the share and the surplus open nothing", async () => {
    draw('&dv=ga');
    const table = await screen.findByRole('table', { name: 'Department P&L, G&A' });
    fireEvent.click(within(rowOf(table, 'Finance team · salary, EPF, SOCSO, EIS, allowance')).getByRole('button', { name: '16,400.00' }));
    const panel = await screen.findByRole('region', { name: 'Lines of Finance team · salary, EPF, SOCSO, EIS, allowance' });
    expect(await within(panel).findByText('FINANCE - SALARY - OCT2026')).toBeTruthy();
    expect(within(panel).getByText('16,400.00')).toBeTruthy();
    expect(linesAsked().at(-1)).toEqual({ view: 'ga', from: '2026-09-01', to: '2026-10-31', keys: 'team:FINANCE' });
    for (const label of ['Performance sales', 'G&A share (8% of Performance sales)', 'SURPLUS / (DEFICIT)']) {
      expect(within(rowOf(table, label)).queryAllByRole('button')).toHaveLength(0);
    }
  });

  test("All: a department's figure reads that department's part of the account; Exhibition its own", async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Department P&L, all departments' });
    fireEvent.click(within(rowOf(table, '900-S100 · STAFF SALARIES & OVERTIME')).getByRole('button', { name: '53,400.00' }));
    await screen.findByRole('region', { name: 'Lines of 900-S100 · STAFF SALARIES & OVERTIME' });
    expect(linesAsked().at(-1)).toEqual({ view: 'all', from: '2026-09-01', to: '2026-10-31', block: 'expenses', dept: 'ga', keys: '900-S100' });
    expect(within(rowOf(table, 'NET PROFIT / (LOSS)')).queryAllByRole('button')).toHaveLength(0);
  });

  test('Exhibition: a figure reads the department\'s lines', async () => {
    draw('&dv=exhibition');
    const table = await screen.findByRole('table', { name: 'Department P&L, Exhibition' });
    fireEvent.click(within(rowOf(table, '900-R032 · RENTAL - EXHIBITION')).getByRole('button', { name: '990,000.00' }));
    await screen.findByRole('region', { name: 'Lines of 900-R032 · RENTAL - EXHIBITION' });
    expect(linesAsked().at(-1)).toEqual({ view: 'dept', from: '2026-09-01', to: '2026-10-31', block: 'expenses', d: 'exhibition', keys: '900-R032' });
  });
});
