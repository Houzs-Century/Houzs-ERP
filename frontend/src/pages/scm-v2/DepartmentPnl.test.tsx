/* The Department P&L tab (owner 2026-11-19: an Operation report = his "Operation
   PNL - Auto" sheet, a G&A report, and 「我要可以看全部的，也要可以看单独部门的」;
   2026-11-25: Actual or Performance, the selling department paying the others).
   The replies are made up in the handlers' own shapes over a two-month world
   (DepartmentPnl.fixture.json; the server half is backend/tests/departmentPnl.test.ts).
   Pinned:
     • the company's own departments (Houzs: Exhibition, Operation, Logistics and its
       branch Setup & dismantle, G&A), each with a view of its own; the basis the
       P&L picker names (dbasis) goes with every read;
     • All: each department's own P&L side by side, where each comes from under its
       name, what the Exhibition pays the others, the total the departments added up;
       a figure says where it comes from and opens its department;
     • Exhibition: its sales orders' sales and cost by product group, less what it
       booked, the commission bills and what it pays the others, each charge opening
       its months at the rate; the orders' figures open nothing; merchandise's rate;
     • Operation, Logistics, Setup & dismantle: what each is paid less its real cost;
       Operation's rows open the sheet's lines, Setup & dismantle's accounts theirs;
       Operation's sheet by DO and region beside, its spread saved;
     • G&A: the share of the sales excluding service, the HQ teams under Salary &
       related, the surplus; its rate saved;
     • the department switch lives in the URL;
     • a figure opens the lines behind it (owner 2026-11-20: 「我希望这里点开也能看」),
       totalled to the figure; the results that add up rows open nothing. */

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

const LINES = {
  lines: [
    { id: 'g1', month: '2026-09', day: '2026-09-30', accountCode: '900-S100', accountName: 'STAFF SALARIES & OVERTIME', ref: 'JE-1', text: 'FINANCE - SALARY - SEP2026', dept: 'ga', team: 'FINANCE', sen: 820_000, source: 'ledger' },
    { id: 'g2', month: '2026-10', day: '2026-10-31', accountCode: '900-S100', accountName: 'STAFF SALARIES & OVERTIME', ref: 'JE-2', text: 'FINANCE - SALARY - OCT2026', dept: 'ga', team: 'FINANCE', sen: 820_000, source: 'ledger' },
  ],
  totalSen: 1_640_000,
};
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
  if (path.startsWith('/acc-events/departments/unit?u=operation&')) return fixture.unitOperation;
  if (path.startsWith('/acc-events/departments/unit?u=logistics&')) return fixture.unitLogistics;
  if (path.startsWith('/acc-events/departments/unit?u=setupDismantle&')) return fixture.unitSetupDismantle;
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
  test("each department's own P&L side by side, where each comes from under its name, what the Exhibition pays, the total the departments added up", async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Department P&L, all departments' });
    for (const h of ['Exhibition', 'Operation', 'Logistics', 'Setup & dismantle', 'G&A', 'Total']) expect(within(table).getAllByText(h).length).toBeGreaterThan(0);
    for (const sub of ['sales orders by SO date', '7% of sales, 3% on to Logistics', '3% from Operation', '1% of sales', '8% of sales', 'departments added up']) {
      expect(within(table).getAllByText(sub).length).toBeGreaterThan(0);
    }
    expect(rowText(table, 'Income')).toBe('Income4,300,000.00317,500.00141,000.0042,000.00336,000.005,136,500.00');
    expect(rowText(table, 'Paid to other departments')).toBe('Paid to other departments672,000.00126,000.00---798,000.00');
    expect(rowText(table, 'PROFIT / (LOSS)')).toBe('PROFIT / (LOSS)4,000.00(7,131.90)6,000.009,000.0082,885.8494,753.94');
    expect(within(table).queryByText('Other income')).toBeNull();
    expect(screen.getByText('Exhibition profit')).toBeTruthy();
    expect(screen.getByText('Departments added up')).toBeTruthy();
    expect(screen.getByText(/No department yet: 900-U014/)).toBeTruthy();
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/acc-events/departments/all?dbasis=performance&from=2026-09-01&to=2026-10-31'))).toBe(true);
  });

  test("a figure says where it comes from and opens its department's own P&L", async () => {
    draw();
    const table = await screen.findByRole('table', { name: 'Department P&L, all departments' });
    fireEvent.click(within(rowOf(table, 'Income')).getByRole('button', { name: '4,300,000.00' }));
    const where = await screen.findByRole('region', { name: 'Exhibition · Income' });
    expect(within(where).getByText(/The sales orders dated in these months/)).toBeTruthy();
    fireEvent.click(within(rowOf(table, 'Paid to other departments')).getByRole('button', { name: '672,000.00' }));
    const pays = await screen.findByRole('region', { name: 'Exhibition · Paid to other departments' });
    expect(within(pays).getByText('G&A 8%, Operation 7%, Setup & dismantle 1% of its sales excluding service.')).toBeTruthy();
    fireEvent.click(within(rowOf(table, 'PROFIT / (LOSS)')).getByRole('button', { name: '(7,131.90)' }));
    const op = await screen.findByRole('region', { name: 'Operation · PROFIT / (LOSS)' });
    fireEvent.click(within(op).getByRole('button', { name: 'Open the Operation P&L' }));
    expect(await screen.findByRole('table', { name: 'Department P&L, Operation' })).toBeTruthy();
  });

  test('Actual: the basis the picker names goes with the read', async () => {
    draw('&dbasis=actual');
    await screen.findByRole('table', { name: 'Department P&L, all departments' });
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/acc-events/departments/all?dbasis=actual&from=2026-09-01'))).toBe(true);
  });

  test('the switch offers every department of the company, Setup & dismantle after Logistics, and lives in the URL', async () => {
    draw();
    await screen.findByRole('table', { name: 'Department P&L, all departments' });
    const group = screen.getByRole('group', { name: 'Department' });
    await waitFor(() => expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All departments', 'Exhibition', 'Operation', 'Logistics', 'Setup & dismantle', 'G&A']));
    fireEvent.click(within(group).getByRole('button', { name: 'Operation' }));
    expect(await screen.findByRole('table', { name: 'Department P&L, Operation' })).toBeTruthy();
    expect(fetchMock.mock.calls.some(([p]) => String(p).startsWith('/acc-events/departments/unit?u=operation&dbasis=performance&from=2026-09-01&to=2026-10-31'))).toBe(true);
  });
});

describe('Exhibition', () => {
  test("the Exhibition P&L on its orders: the product groups' sales and cost, less what it booked, its commission bills and what it pays the others", async () => {
    draw('&dv=exhibition');
    const table = await screen.findByRole('table', { name: 'Department P&L, Exhibition' });
    expect(within(table).getByText('SALES (SALES ORDERS BY SO DATE)')).toBeTruthy();
    expect(rowText(table, 'Bedframe')).toContain('1,700,000.00');
    expect(rowText(table, 'Total sales')).toContain('4,300,000.00');
    expect(rowText(table, 'Total cost of sales')).toContain('1,790,000.00');
    expect(rowText(table, 'GROSS PROFIT')).toContain('2,510,000.00');
    expect(within(table).getByText('900-C003 COMMISSION ( EVENT ) — the commission bills for Sep 2026, Oct 2026, in place of the monthly release')).toBeTruthy();
    expect(rowText(table, 'G&A — 8% of sales excluding service')).toContain('336,000.00');
    expect(rowText(table, 'Total paid to other departments')).toContain('672,000.00');
    expect(rowText(table, 'EXHIBITION PROFIT / (LOSS)')).toContain('4,000.00');
    expect(screen.getByText('40 orders by SO date')).toBeTruthy();
    expect(within(rowOf(table, 'Bedframe')).queryAllByRole('button')).toHaveLength(0);
    expect(within(rowOf(table, 'Total sales')).queryAllByRole('button')).toHaveLength(0);
  });

  test("a charge opens its months at the rate; merchandise's rate is Finance's to set", async () => {
    draw('&dv=exhibition');
    const table = await screen.findByRole('table', { name: 'Department P&L, Exhibition' });
    fireEvent.click(within(rowOf(table, 'G&A — 8% of sales excluding service')).getByRole('button', { name: '336,000.00' }));
    const panel = await screen.findByRole('region', { name: 'Lines of G&A — 8% of sales excluding service' });
    expect(within(panel).getByText("8% of the month's sales excluding service, 1,950,000.00")).toBeTruthy();
    expect(within(panel).getByText("8% of the month's sales excluding service, 2,250,000.00")).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Merchandise percent'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putOf('/acc-events/departments/rate')).toContainEqual({ dept: 'merchandise', pct: 2.5 }));
  });
});

describe('Operation, Logistics, Setup & dismantle', () => {
  test('Operation: its 7% and what it billed, less the 3% to Logistics and the warehouse; a row opens its lines', async () => {
    draw('&dv=operation');
    const table = await screen.findByRole('table', { name: 'Department P&L, Operation' });
    expect(rowText(table, 'Sales excluding service (sales orders by SO date)')).toContain('4,200,000.00');
    expect(rowText(table, 'From the selling department (7% of sales excluding service)')).toContain('294,000.00');
    expect(rowText(table, 'Logistics — 3% of sales excluding service')).toContain('126,000.00');
    expect(rowText(table, 'Total paid to other departments')).toContain('126,000.00');
    expect(rowText(table, 'Rental Warehouse')).toContain('96,600.00');
    expect(rowText(table, 'OPERATION PROFIT / (LOSS)')).toContain('(7,131.90)');
    fireEvent.click(within(rowOf(table, 'Rental Warehouse')).getByRole('button', { name: '96,600.00' }));
    const rental = await screen.findByRole('region', { name: 'Lines of Rental Warehouse' });
    expect(within(rental).getByText('96,600.00')).toBeTruthy();
    fireEvent.click(within(rowOf(table, 'Logistics — 3% of sales excluding service')).getAllByRole('button', { name: '126,000.00' })[0]!);
    const toLg = await screen.findByRole('region', { name: 'Lines of Logistics — 3% of sales excluding service' });
    expect(within(toLg).getByText("3% of the month's sales excluding service, 1,950,000.00")).toBeTruthy();
  });

  test('Logistics: the 3% from Operation, the recharges and the trips, less the delivery cost', async () => {
    draw('&dv=logistics');
    const table = await screen.findByRole('table', { name: 'Department P&L, Logistics' });
    expect(rowText(table, 'From Operation (3% of sales excluding service)')).toContain('126,000.00');
    expect(rowText(table, 'Outsource (3PL)')).toContain('85,000.00');
    expect(rowText(table, 'LOGISTICS PROFIT / (LOSS)')).toContain('6,000.00');
    expect(within(rowOf(table, 'Outsource (3PL)')).queryAllByRole('button')).toHaveLength(0);
  });

  test('Setup & dismantle: its 1%, less the fair transport as booked and the in-house trips; an account opens its lines', async () => {
    draw('&dv=setupDismantle');
    const table = await screen.findByRole('table', { name: 'Department P&L, Setup & dismantle' });
    expect(rowText(table, 'From the selling department (1% of sales excluding service)')).toContain('42,000.00');
    expect(rowText(table, 'SETUP & DISMANTLE PROFIT / (LOSS)')).toContain('9,000.00');
    fireEvent.click(within(rowOf(table, '900-T031 · TRANSPORT FAIR (KL, SLG, MLK, JHR, OTHERS)')).getByRole('button', { name: '28,000.00' }));
    await screen.findByRole('region', { name: 'Lines of 900-T031 · TRANSPORT FAIR (KL, SLG, MLK, JHR, OTHERS)' });
    expect(linesAsked().at(-1)).toEqual({ view: 'sd', dbasis: 'performance', from: '2026-09-01', to: '2026-10-31', keys: '900-T031' });
  });

  test('the Show switch keeps its place in the URL from one department to another', async () => {
    draw('&dv=operation&dm=months');
    await screen.findByRole('table', { name: 'Department P&L, Operation' });
    fireEvent.click(within(screen.getByRole('group', { name: 'Department' })).getByRole('button', { name: 'Logistics' }));
    await screen.findByRole('table', { name: 'Department P&L, Logistics' });
    expect(within(screen.getByRole('group', { name: 'Whole range or by month' })).getByRole('button', { name: 'By month' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('departmentChoices', () => {
  test("All, the company's own departments, Setup & dismantle after Logistics; nothing but All before the plan", () => {
    expect(departmentChoices(undefined).map((c) => c.value)).toEqual(['all']);
    expect(departmentChoices(fixture.plan as DepartmentPlan).map((c) => `${c.value}:${c.kind}`))
      .toEqual(['all:all', 'exhibition:dept', 'operation:operation', 'logistics:logistics', 'setupDismantle:setupDismantle', 'ga:ga']);
    expect(departmentChoices({ departments: [{ key: 'showroom', label: 'Showroom', view: 'dept' }, { key: 'ga', label: 'G&A', view: 'ga' }], selling: 'showroom', branches: [] })
      .map((c) => `${c.value}:${c.kind}`)).toEqual(['all:all', 'showroom:dept', 'ga:ga']);
  });
});

describe('G&A', () => {
  test('its share of the sales excluding service against what it booked; the HQ teams; the surplus; the rate saved', async () => {
    draw('&dv=ga');
    const table = await screen.findByRole('table', { name: 'Department P&L, G&A' });
    expect(rowText(table, 'Sales excluding service (sales orders by SO date)')).toContain('4,200,000.00');
    expect(rowText(table, 'G&A share (8% of sales excluding service)')).toContain('336,000.00');
    expect(within(table).getByText('Finance team · salary, EPF, SOCSO, EIS, allowance')).toBeTruthy();
    expect(rowText(table, 'SURPLUS / (DEFICIT)')).toContain('82,885.84');
    fireEvent.change(screen.getByLabelText('G&A share percent'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putOf('/acc-events/departments/rate')).toContainEqual({ dept: 'ga', pct: 10 }));
  });

  test('by month: a Total, then one column per month', async () => {
    draw('&dv=ga&dm=months');
    const table = await screen.findByRole('table', { name: 'Department P&L, G&A' });
    const heads = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads[1]).toMatch(/^Total/);
    expect(heads.slice(2).map((h) => h.replace(/%$/, ''))).toEqual(expect.arrayContaining([expect.stringMatching(/Sep/), expect.stringMatching(/Oct/)]));
  });
});

describe("Operation's sheet by DO and region", () => {
  test("the owner's sheet by region, a % of DO beside; the fairs said when unread; the insurance spread saved", async () => {
    draw('&dv=operation&dop=sheet');
    const table = await screen.findByRole('table', { name: 'Operation sheet, by DO and region' });
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

const linesAsked = () => fetchMock.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith('/acc-events/departments/lines?')).map((p) => Object.fromEntries(new URLSearchParams(p.split('?')[1])));

describe('A figure opens the lines behind it', () => {
  test("the sheet: a row's figure opens its lines in that column, totalled to the figure; the results open nothing", async () => {
    draw('&dv=operation&dop=sheet');
    const table = await screen.findByRole('table', { name: 'Operation sheet, by DO and region' });
    fireEvent.click(within(rowOf(table, 'Rental Warehouse')).getByRole('button', { name: '55,000.00' }));
    const rental = await screen.findByRole('region', { name: 'Lines of Rental Warehouse' });
    expect(within(rental).getByText(/Sep 2026 – Oct 2026 · KL · 2 lines/)).toBeTruthy();
    expect(within(rental).getAllByText('27,500.00')).toHaveLength(2);
    expect(within(rental).getByText('55,000.00')).toBeTruthy();
    expect(within(rental).getByRole('link', { name: /Open in General ledger/ }).getAttribute('href')).toContain('accounts=900-R005');
    fireEvent.click(within(rental).getByRole('button', { name: 'Close the lines' }));
    expect(screen.queryByRole('region', { name: 'Lines of Rental Warehouse' })).toBeNull();
    fireEvent.click(within(rowOf(table, 'Warehouse Manpower - Logistic')).getByRole('button', { name: '14,534.17' }));
    const pay = await screen.findByRole('region', { name: 'Lines of Warehouse Manpower - Logistic' });
    expect(within(pay).getAllByText('DO-value share of the line 10,000.00')).toHaveLength(2);
    expect(within(pay).getByText('14,534.17')).toBeTruthy();
    for (const label of ['Gross Profit / (Loss)', 'Net Profit / (Loss)', 'Net Profit / (Loss) After Logistics & Setup/Dismantle']) {
      expect(within(rowOf(table, label)).queryAllByRole('button')).toHaveLength(0);
    }
    fireEvent.click(within(rowOf(table, '7% Income from Delivery Order')).getAllByRole('button')[0]!);
    const income = await screen.findByRole('region', { name: 'Lines of 7% Income from Delivery Order' });
    expect(within(income).getByText('7% of the DO value 450,000.00')).toBeTruthy();
  });

  test('the sheet: Total Warehouse Expenses opens every warehouse line, each with its row', async () => {
    draw('&dv=operation&dop=sheet');
    const table = await screen.findByRole('table', { name: 'Operation sheet, by DO and region' });
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
    expect(linesAsked().at(-1)).toEqual({ view: 'ga', dbasis: 'performance', from: '2026-09-01', to: '2026-10-31', keys: 'team:FINANCE' });
    for (const label of ['Sales excluding service (sales orders by SO date)', 'G&A share (8% of sales excluding service)', 'SURPLUS / (DEFICIT)']) {
      expect(within(rowOf(table, label)).queryAllByRole('button')).toHaveLength(0);
    }
  });

  test("Exhibition: a figure reads the department's lines on the page's basis", async () => {
    draw('&dv=exhibition');
    const table = await screen.findByRole('table', { name: 'Department P&L, Exhibition' });
    fireEvent.click(within(rowOf(table, '900-R032 · RENTAL - EXHIBITION')).getByRole('button', { name: '990,000.00' }));
    await screen.findByRole('region', { name: 'Lines of 900-R032 · RENTAL - EXHIBITION' });
    expect(linesAsked().at(-1)).toEqual({ view: 'dept', dbasis: 'performance', from: '2026-09-01', to: '2026-10-31', block: 'expenses', d: 'exhibition', keys: '900-R032' });
    const label = '900-C003 COMMISSION ( EVENT ) — the commission bills for Sep 2026, Oct 2026, in place of the monthly release';
    fireEvent.click(within(rowOf(table, label)).getByRole('button', { name: '602,000.00' }));
    const bill = await screen.findByRole('region', { name: `Lines of ${label}` });
    expect(await within(bill).findByText('The commission bill for Oct 2026, in place of the monthly release')).toBeTruthy();
    expect(within(bill).getByText('The commission bill for Sep 2026, in place of the monthly release')).toBeTruthy();
    expect(linesAsked().at(-1)).toEqual({ view: 'dept', dbasis: 'performance', from: '2026-09-01', to: '2026-10-31', block: 'expenses', d: 'exhibition', keys: '900-C003' });
  });
});
