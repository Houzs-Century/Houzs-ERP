/* The Department P&L tab (owner 2026-11-19: an Operation report = his "Operation
   PNL - Auto" sheet, a G&A report, and 「我要可以看全部的，也要可以看单独部门的」;
   2026-11-25: each department by its own method, the Exhibition on its orders).
   The replies are made up in the handlers' own shapes over a two-month world
   (DepartmentPnl.fixture.json; the server half is backend/tests/departmentPnl.test.ts).
   Pinned:
     • the company's own departments (Houzs: Exhibition, Operation, Logistics, G&A),
       each with a view of its own — Logistics the whole Logistics cost report;
     • All: each department's own P&L side by side, where each comes from under its
       name, the total the departments added up; a figure says where it comes from
       and opens its department;
     • Exhibition: its sales orders' sales and cost by product group, less what it
       booked and the commission bills; the orders' figures open nothing;
     • Logistics: the whole Logistics cost report, its four views beside the
       department picker, every company's — 2990, with no Logistics department, is
       offered it all the same (owner 2026-11-25); the Show switch keeps its name;
     • G&A: the share of the Performance sales, the HQ teams under Salary & related,
       the surplus; its rate saved;
     • Operation: the owner's sheet by region with a % of DO beside; the rows in his
       words; the warehouse insurance spread, its months saved;
     • the department switch lives in the URL;
     • a figure opens the lines behind it (owner 2026-11-20: 「我希望这里点开也能看」):
       the Operation sheet's from the report (the fixture's `lines`, derived from its
       own rows and lists so that each row is its lines added up), totalled to the
       figure; Exhibition and G&A read theirs for the figure's column (the
       Exhibition's commission its bills); the results that add up rows open nothing. */

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

import { DepartmentPnlTab, departmentChoices } from './DepartmentPnl';
import type { DepartmentPlan } from '../../vendor/scm/lib/department-queries';

/* What a figure of All, Exhibition or G&A reads when opened: made-up lines. */
const LINES = {
  lines: [
    { id: 'g1', month: '2026-09', day: '2026-09-30', accountCode: '900-S100', accountName: 'STAFF SALARIES & OVERTIME', ref: 'JE-1', text: 'FINANCE - SALARY - SEP2026', dept: 'ga', team: 'FINANCE', sen: 820_000, source: 'ledger' },
    { id: 'g2', month: '2026-10', day: '2026-10-31', accountCode: '900-S100', accountName: 'STAFF SALARIES & OVERTIME', ref: 'JE-2', text: 'FINANCE - SALARY - OCT2026', dept: 'ga', team: 'FINANCE', sen: 820_000, source: 'ledger' },
  ],
  totalSen: 1_640_000,
};
/* The Exhibition's commission: its bill, in the month it pays for, beside what else is booked on the account. */
const BILL_LINES = {
  lines: [
    { id: 'bill:2026-09:HC-API-8:0', month: '2026-09', day: '2026-10-15', accountCode: '360-0050', accountName: 'PREPAYMENT COMMISSION', ref: 'HC-API-8', text: "REVENUE TEAM PAYROLL TO COLLECT BACK - SEP'26", dept: 'exhibition', team: null, sen: 280_000_00, source: 'bill' },
    { id: 'bill:2026-10:HC-API-9:0', month: '2026-10', day: '2026-11-15', accountCode: '360-0050', accountName: 'PREPAYMENT COMMISSION', ref: 'HC-API-9', text: "REVENUE TEAM PAYROLL TO COLLECT BACK - OCT'26", dept: 'exhibition', team: null, sen: 322_000_00, source: 'bill' },
  ],
  totalSen: 602_000_00,
};
fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
  if (init?.method === 'PUT') return { ok: true };
  if (path === '/acc-events/departments/plan') return fixture.plan;
  if (path.startsWith('/acc-events/departments/lines?') && path.includes('keys=900-C003')) return BILL_LINES;
  if (path.startsWith('/acc-events/departments/lines?')) return LINES;
  if (path.startsWith('/acc-events/departments/dept?d=exhibition&')) return fixture.exhibition;
  if (path.startsWith('/acc-events/logistics/pnl?')) return fixture.logistics;
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
const rowOf = (table: HTMLElement, label: string) => within(table).getAllByText(label)[0]!.closest('tr')!;

describe('All departments', () => {
  test("each department's own P&L side by side, where each comes from under its name, the total the departments added up", async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Department P&L, all departments' });
    for (const h of ['Exhibition', 'Operation', 'Logistics', 'G&A', 'Total']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    for (const sub of ['sales orders by SO date', 'Operation sheet, to Net Profit', 'Logistics P&L', '8% of Performance sales', 'departments added up']) {
      expect(within(table).getAllByText(sub).length).toBeGreaterThan(0);
    }
    /* Income: the Exhibition's orders, Operation's DO income and charges, Logistics' P&L, G&A's share. */
    expect(rowText(table, 'Income')).toBe('Income4,300,000.00331,500.00151,000.00344,000.005,126,500.00');
    expect(rowText(table, 'Cost of sales')).toBe('Cost of sales1,790,000.00132,000.00--1,922,000.00');
    expect(rowText(table, 'PROFIT / (LOSS)')).toBe('PROFIT / (LOSS)676,000.00868.1011,000.0090,885.84778,753.94');
    expect(within(table).queryByText('Other income')).toBeNull();
    expect(screen.getByText('Exhibition profit')).toBeTruthy();
    expect(screen.getByText('Departments added up')).toBeTruthy();
    expect(screen.getByText(/No department yet: 900-U014/)).toBeTruthy();
  });

  test("a figure says where it comes from and opens its department's own P&L", async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Department P&L, all departments' });
    fireEvent.click(within(rowOf(table, 'Income')).getByRole('button', { name: '4,300,000.00' }));
    const where = await screen.findByRole('region', { name: 'Exhibition · Income' });
    expect(within(where).getByText(/The sales orders dated in these months/)).toBeTruthy();
    /* One figure open at a time: Operation's profit says it stops before the Logistics result. */
    fireEvent.click(within(rowOf(table, 'PROFIT / (LOSS)')).getByRole('button', { name: '868.10' }));
    const op = await screen.findByRole('region', { name: 'Operation · PROFIT / (LOSS)' });
    expect(within(op).getByText(/before Profit From Logistics/)).toBeTruthy();
    fireEvent.click(within(op).getByRole('button', { name: 'Open the Operation P&L' }));
    expect(await screen.findByRole('table', { name: 'Department P&L, Operation' })).toBeTruthy();
  });

  test("the switch offers every department of the company — Logistics its own P&L — and lives in the URL", async () => {
    draw();
    await screen.findByRole('table', { name: 'Department P&L, all departments' });
    const group = screen.getByRole('group', { name: 'Department' });
    await waitFor(() => expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All departments', 'Exhibition', 'Operation', 'Logistics', 'G&A']));
    fireEvent.click(within(group).getByRole('button', { name: 'Operation' }));
    expect(await screen.findByRole('table', { name: 'Department P&L, Operation' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/acc-events/departments/operation?from=2026-09-01&to=2026-10-31'))).toBe(true);
  });
});

describe('Exhibition', () => {
  test("the Exhibition P&L on its orders: the product groups' sales and cost, less what Exhibition booked and its commission bills", async () => {
    draw('&dv=exhibition');
    const table = await screen.findByRole('table', { name: 'Department P&L, Exhibition' });
    expect(within(table).getByText('SALES (SALES ORDERS BY SO DATE)')).toBeTruthy();
    expect(rowText(table, 'Bedframe')).toContain('1,700,000.00');
    expect(rowText(table, 'Total sales')).toContain('4,300,000.00');
    expect(rowText(table, 'Total cost of sales')).toContain('1,790,000.00');
    expect(rowText(table, 'GROSS PROFIT')).toContain('2,510,000.00');
    expect(within(table).getByText('900-C003 COMMISSION ( EVENT ) — the commission bills for Sep 2026, Oct 2026, in place of the monthly release')).toBeTruthy();
    expect(rowText(table, 'EXHIBITION PROFIT / (LOSS)')).toContain('676,000.00');
    expect(screen.getByText('40 orders by SO date')).toBeTruthy();
    /* The orders' figures are the Performance P&L's: no ledger line behind them. */
    expect(within(rowOf(table, 'Bedframe')).queryAllByRole('button')).toHaveLength(0);
    expect(within(rowOf(table, 'Total sales')).queryAllByRole('button')).toHaveLength(0);
  });
});

describe('Logistics', () => {
  test('the whole Logistics cost report: its four views beside the department picker, its P&L first', async () => {
    draw('&dv=logistics');
    const table = await screen.findByRole('table', { name: 'Logistics P&L' });
    expect(rowText(table, 'NET PROFIT')).toContain('11,000.00');
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/acc-events/logistics/pnl?from=2026-09-01&to=2026-10-31'))).toBe(true);
    expect(within(screen.getByRole('group', { name: 'Logistics views' })).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['P&L', 'By region & trip', 'Setup & Dismantle', 'Spend by lorry']);
    const depts = screen.getByRole('group', { name: 'Department' });
    expect(within(depts).getByRole('button', { name: 'Logistics' }).getAttribute('aria-pressed')).toBe('true');
    /* One toolbar: the dates, the departments, then the report's own tools. */
    expect(screen.getAllByRole('toolbar')).toHaveLength(1);
  });

  test('a company with no Logistics department (2990) is offered Logistics all the same', async () => {
    const own = fixture.plan.departments;
    fixture.plan.departments = [
      { key: 'showroom', label: 'Showroom', view: 'dept', basis: 'books' },
      { key: 'ga', label: 'G&A', view: 'ga', basis: null },
    ] as typeof own;
    try {
      draw('&dv=logistics');
      expect(await screen.findByRole('table', { name: 'Logistics P&L' })).toBeTruthy();
      expect(within(screen.getByRole('group', { name: 'Department' })).getAllByRole('button').map((b) => b.textContent))
        .toEqual(['All departments', 'Showroom', 'G&A', 'Logistics']);
    } finally {
      fixture.plan.departments = own;
    }
  });

  test('the Show switch keeps its place in the URL from a department to Logistics', async () => {
    draw('&dv=operation&dm=months');
    await screen.findByRole('table', { name: 'Department P&L, Operation' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Department' })).getByRole('button', { name: 'Logistics' }));
    await screen.findByRole('group', { name: 'Logistics views' });
    expect(within(screen.getByRole('group', { name: 'Whole range or by month' })).getByRole('button', { name: 'By month' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('departmentChoices', () => {
  test('All, the company\'s own departments, and Logistics where it has none; nothing but All before the plan', () => {
    expect(departmentChoices(undefined).map((c) => c.value)).toEqual(['all']);
    expect(departmentChoices(fixture.plan as DepartmentPlan).map((c) => c.value)).toEqual(['all', 'exhibition', 'operation', 'logistics', 'ga']);
    expect(departmentChoices({ departments: [{ key: 'showroom', label: 'Showroom', view: 'dept', basis: 'books' }, { key: 'ga', label: 'G&A', view: 'ga', basis: null }], selling: 'showroom' })
      .map((c) => `${c.value}:${c.kind}`)).toEqual(['all:all', 'showroom:dept', 'ga:ga', 'logistics:logistics']);
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

  test('Exhibition: a figure reads the department\'s lines', async () => {
    draw('&dv=exhibition');
    const table = await screen.findByRole('table', { name: 'Department P&L, Exhibition' });
    fireEvent.click(within(rowOf(table, '900-R032 · RENTAL - EXHIBITION')).getByRole('button', { name: '990,000.00' }));
    await screen.findByRole('region', { name: 'Lines of 900-R032 · RENTAL - EXHIBITION' });
    expect(linesAsked().at(-1)).toEqual({ view: 'dept', from: '2026-09-01', to: '2026-10-31', block: 'expenses', d: 'exhibition', keys: '900-R032' });
    /* The commission opens its bill, said as such. */
    const label = '900-C003 COMMISSION ( EVENT ) — the commission bills for Sep 2026, Oct 2026, in place of the monthly release';
    fireEvent.click(within(rowOf(table, label)).getByRole('button', { name: '602,000.00' }));
    const bill = await screen.findByRole('region', { name: `Lines of ${label}` });
    expect(await within(bill).findByText('The commission bill for Oct 2026, in place of the monthly release')).toBeTruthy();
    expect(within(bill).getByText('The commission bill for Sep 2026, in place of the monthly release')).toBeTruthy();
    expect(linesAsked().at(-1)).toEqual({ view: 'dept', from: '2026-09-01', to: '2026-10-31', block: 'expenses', d: 'exhibition', keys: '900-C003' });
  });
});
