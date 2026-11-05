/* The Performance P&L tab (owner 2026-09-12, docs/bugs/0835), in the owner's
   Claude Design (batch 6 step 12): the product groups with sales, cost, gross
   profit and GP %; the other income and the expenses on the report's tree —
   the computed operating expense where the account it replaces sits — to
   NET PERFORMANCE; the notes; the operating expense line (Change edits the
   rate, the account and the accounts the rate also covers, owner 2026-10-06);
   By month a column per month; the chart from read c6; Excel / PDF / Print as
   shown. The server half is backend/tests/performanceReport.test.ts and
   performanceMonths.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PerformanceMonth, PerformanceReport } from '../../vendor/scm/lib/performance-report-queries';
import type { LaidNode } from '../../vendor/scm/lib/report-layout';

const acc = (code: string, label: string, amountSen: number, pct: number | null): LaidNode =>
  ({ kind: 'account', id: `acc:${code}`, label, code, key: code, amountSen, pct, children: [] });
const OPEX_LABEL = 'Operating expense — 16.00% of sales excluding service (5,000.00), in place of 900-O001 OPERATIING EXPENSE';

const report: PerformanceReport = {
  from: '2026-07-01', to: '2026-07-31',
  orders: { counted: 4, notDelivered: 3, excludedDraft: 1, excludedCancelled: 1 },
  groups: [
    { key: 'bedframe', label: 'Bedframe', lines: 1, salesSen: 50000, cogsSen: 20000, gpSen: 30000, gpPct: 60 },
    { key: 'mattress', label: 'Mattress', lines: 1, salesSen: 100000, cogsSen: 60000, gpSen: 40000, gpPct: 40 },
    { key: 'sofa', label: 'Sofa', lines: 2, salesSen: 300000, cogsSen: 180000, gpSen: 120000, gpPct: 40 },
    { key: 'accessory', label: 'Accessory', lines: 1, salesSen: 0, cogsSen: 12000, gpSen: -12000, gpPct: null },
    { key: 'service', label: 'Service / transport income', lines: 1, salesSen: 73000, cogsSen: 29000, gpSen: 44000, gpPct: 60.3 },
  ],
  totals: { salesSen: 523000, cogsSen: 301000, gpSen: 222000, gpPct: 42.4, salesExServiceSen: 500000 },
  operatingExpense: { rateBp: 1600, baseSen: 500000, amountSen: 80000, account: '900-O001', accountName: 'OPERATIING EXPENSE', accountFound: true, bookedSen: 243550 },
  otherIncome: [{ code: '590-0000', name: 'RENT RECEIVED', amountSen: 50000 }],
  otherIncomeSen: 50000,
  otherExpenses: [
    { code: '900-A014', name: 'ADVERTISEMENT - SHOWROOM', amountSen: 100000 },
    { code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 4500000 },
  ],
  otherExpensesSen: 4600000,
  netSen: -4408000, netPct: -842.8,
  settings: { rateBp: 1600, account: '900-O001' },
  layout: {
    stored: true, baseSen: 523000,
    otherIncome: [acc('590-0000', '590-0000 · RENT RECEIVED', 50000, 9.6)],
    expenses: [
      { kind: 'category', id: 'cat:fixed', label: 'Fixed costs', amountSen: 4580000, pct: 875.7, children: [
        acc('900-R048', '900-R048 · RENTAL OF SHOWROOM', 4500000, 860.4),
        acc('900-O001', OPEX_LABEL, 80000, 15.3),
      ] },
      acc('900-A014', '900-A014 · ADVERTISEMENT - SHOWROOM', 100000, 19.1),
    ],
  },
};
const MONTHS: PerformanceMonth[] = [
  { month: '2026-06', from: '2026-06-01', to: '2026-06-30', salesSen: 400000, cogsSen: 250000, gpSen: 150000, gpPct: 37.5, otherIncomeSen: 0, expensesSen: 100000, netSen: 50000, netPct: 12.5 },
  { month: '2026-07', from: '2026-07-01', to: '2026-07-31', salesSen: 523000, cogsSen: 301000, gpSen: 222000, gpPct: 42.4, otherIncomeSen: 50000, expensesSen: 4680000, netSen: -4408000, netPct: -842.8 },
];

const served = vi.hoisted(() => ({ report: null as unknown, reads: [] as string[] }));
const saveMutate = vi.fn();
const xlsx = vi.fn(async (..._a: unknown[]) => {});

vi.mock('../../vendor/scm/lib/performance-report-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  usePerformanceReport: (from: string, to: string) => ({ data: from && to ? served.report : undefined, isLoading: false, isError: false, error: null }),
  usePerformanceMonths: (from: string | null, to: string | null) => ({ data: from && to ? { from, to, months: MONTHS } : undefined, isLoading: false, isError: false }),
  useSavePerformanceSettings: () => ({ mutate: saveMutate, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: vi.fn(async (path: string) => { served.reads.push(path); return served.report; }),
}));
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, user: null, pageAccess: () => 'full' }) }));
vi.mock('./ReportLayoutEditor', () => ({ ReportLayoutEditor: () => <div role="dialog" aria-label="Layout · Performance P&L">editor</div> }));

const { PerformanceTab, performanceChartMonths } = await import('./PerformancePnl');

const draw = (url = '/scm/accounting?tab=performance&from=2026-07-01&to=2026-07-31') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><PerformanceTab /></MemoryRouter>
  </QueryClientProvider>,
);
const statement = () => within(screen.getByRole('table', { name: 'Performance P&L' }));
const rowOf = (re: RegExp) => statement().getAllByRole('row').find((r) => re.test(r.textContent))!;

beforeEach(() => {
  served.report = report;
  served.reads = [];
  saveMutate.mockReset();
  xlsx.mockClear();
  window.localStorage.removeItem('fin-reports-colw-v2');
});

describe('the Performance P&L — Single', () => {
  test('the product groups with sales, cost, gross profit and GP %; the total names the orders; the account part runs to NET PERFORMANCE', () => {
    draw();
    const sofa = rowOf(/^Sofa· 2 lines/);
    expect(within(sofa).getByText('3,000.00')).toBeTruthy();
    expect(within(sofa).getByText('1,800.00')).toBeTruthy();
    expect(within(sofa).getByText('1,200.00')).toBeTruthy();
    expect(within(sofa).getByText('40.0%')).toBeTruthy();
    const accessory = rowOf(/^Accessory/);
    expect(within(accessory).getByText('(120.00)')).toBeTruthy();
    const total = rowOf(/^Total· 4 orders, 3 not yet delivered/);
    expect(within(total).getByText('5,230.00')).toBeTruthy();
    expect(within(total).getByText('42.4%')).toBeTruthy();
    expect(rowOf(/^Product groups· GP % = gross profit ÷ that group’s own sales/)).toBeTruthy();
    /* The account part: the amount under Gross profit, the % of sales beside it. */
    const rent = rowOf(/RENT RECEIVED/);
    expect(within(rent).getByText('500.00')).toBeTruthy();
    expect(within(rent).getByText('9.6%')).toBeTruthy();
    expect(rowOf(/^Total other income \(as booked\)/)).toBeTruthy();
    const fixed = rowOf(/^Total Fixed costs/);
    expect(within(fixed).getByText('45,800.00')).toBeTruthy();
    expect(within(fixed).getByText('875.7%')).toBeTruthy();
    const opex = rowOf(/Operating expense — 16\.00%/);
    expect(opex.textContent).toContain('in place of 900-O001 OPERATIING EXPENSE');
    expect(within(opex).getByText('800.00')).toBeTruthy();
    expect(opex.getAttribute('data-depth')).toBe('2');
    const expenses = rowOf(/^Total expenses \(operating expense at 16\.00% \+ as booked\)/);
    expect(within(expenses).getByText('46,800.00')).toBeTruthy();
    const net = rowOf(/^NET PERFORMANCE/);
    expect(within(net).getByText('(44,080.00)')).toBeTruthy();
    expect(screen.getByLabelText('Performance notes').textContent).toContain('the 2,435.50 booked on that account in the period is left out');
  });

  test('the operating expense line: Change edits the rate and the account, Save sends basis points, errors are named', () => {
    draw();
    const line = screen.getByLabelText('Performance settings');
    expect(line.textContent).toContain('16.00% of sales excluding service, in place of 900-O001 OPERATIING EXPENSE');
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }));
    const rate = within(line).getByLabelText('Operating expense rate percent') as HTMLInputElement;
    expect(rate.value).toBe('16.00');
    fireEvent.change(rate, { target: { value: '120' } });
    fireEvent.click(within(line).getByRole('button', { name: 'Save' }));
    expect(within(line).getByRole('alert').textContent).toBe('The rate must be between 0% and 100%.');
    fireEvent.change(rate, { target: { value: '18' } });
    fireEvent.change(within(line).getByLabelText('Operating expense account'), { target: { value: ' ' } });
    fireEvent.click(within(line).getByRole('button', { name: 'Save' }));
    expect(within(line).getByRole('alert').textContent).toBe('Name the account the rate stands in for.');
    fireEvent.change(within(line).getByLabelText('Operating expense account'), { target: { value: '900-O001' } });
    fireEvent.click(within(line).getByRole('button', { name: 'Save' }));
    expect(saveMutate.mock.calls[0]?.[0]).toEqual({ rateBp: 1800, account: '900-O001', also: [] });
    fireEvent.click(within(line).getByRole('button', { name: 'Cancel' }));
    expect(within(line).queryByLabelText('Operating expense rate percent')).toBeNull();
  });

  test('the rate also covers transport (2990): the line names the codes, the box holds them, save sends the list', () => {
    served.report = {
      ...report,
      settings: { rateBp: 1600, account: '900-O001', also: ['900-T004', '900-Z999'] },
      operatingExpense: { ...report.operatingExpense, also: [{ code: '900-T004', name: 'TRANSPORTATION FEE' }, { code: '900-Z999', name: null }], alsoBookedSen: 1260720 },
    };
    draw();
    const line = screen.getByLabelText('Performance settings');
    expect(within(line).getByLabelText('Covered accounts').textContent).toBe(' and 900-T004, 900-Z999 not in this company’s chart');
    expect(screen.getByLabelText('Performance notes').textContent).toContain('The rate also covers 900-T004 TRANSPORTATION FEE, 900-Z999');
    fireEvent.click(within(line).getByRole('button', { name: 'Change' }));
    const also = within(line).getByLabelText('Accounts the rate also covers') as HTMLInputElement;
    expect(also.value).toBe('900-T004, 900-Z999');
    fireEvent.change(also, { target: { value: '900-t004 900-T008,, 900-T004' } });
    fireEvent.click(within(line).getByRole('button', { name: 'Save' }));
    expect(saveMutate.mock.calls[0]?.[0]).toEqual({ rateBp: 1600, account: '900-O001', also: ['900-T004', '900-T008'] });
  });

  test('L1 folds the account part to its categories, All opens it; Layout opens the editor', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    expect(statement().queryByText(/^Operating expense — 16/)).toBeNull();
    expect(rowOf(/^Fixed costs/).textContent).toContain('45,800.00');
    expect(rowOf(/^NET PERFORMANCE/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(rowOf(/Operating expense — 16/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · Performance P&L' })).toBeTruthy();
  });

  test('Excel carries the tables as shown, folded to the level chosen', async () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, file] = xlsx.mock.calls[0]! as [{ title: string; tables: Array<{ rows: Array<{ label: string }> }> }, string];
    expect(file).toBe('performance-pnl-2026-07-01-to-2026-07-31.xlsx');
    expect(sheet.title).toBe('Performance P&L');
    const labels = sheet.tables.flatMap((t) => t.rows.map((r) => r.label));
    expect(labels).toContain('Fixed costs');
    expect(labels.some((l) => l.startsWith('Operating expense — 16'))).toBe(false);
  });
});

describe('the Performance P&L — By month and the chart', () => {
  test('By month reads a column per month and the Total, under the design\'s head and captions', async () => {
    draw('/scm/accounting?tab=performance&from=2026-07-01&to=2026-07-31');
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    fireEvent.click(screen.getByRole('button', { name: '3' }));
    await waitFor(() => expect(screen.getByRole('table', { name: 'Performance P&L' })).toBeTruthy());
    expect(served.reads).toEqual(expect.arrayContaining([
      '/accounting/reports/performance?from=2026-05-01&to=2026-07-31',
      '/accounting/reports/performance?from=2026-07-01&to=2026-07-31',
      '/accounting/reports/performance?from=2026-06-01&to=2026-06-30',
      '/accounting/reports/performance?from=2026-05-01&to=2026-05-31',
    ]));
    expect(rowOf(/^Sales· % = share of the month’s sales/)).toBeTruthy();
    expect(rowOf(/^Gross profit by group· % = GP % · gross profit ÷ that group’s own sales/)).toBeTruthy();
    expect(rowOf(/^NET PERFORMANCE/)).toBeTruthy();
    /* The operating expense line stays: the rate applies to every month. */
    expect(screen.getByLabelText('Performance settings')).toBeTruthy();
  });

  test('the chart: sales, cost and expenses a month, net performance under each, GP % and the margin in the card', () => {
    const months = performanceChartMonths({ from: '2026-06-01', to: '2026-08-01' }, MONTHS);
    expect(months.map((m) => [m.month, m.values, m.under])).toEqual([
      ['2026-06-01', { sales: 400000, cogs: 250000, expenses: 100000 }, { text: '0.5', loss: false }],
      ['2026-07-01', { sales: 523000, cogs: 301000, expenses: 4680000 }, { text: '(44)', loss: true }],
      ['2026-08-01', {}, null],
    ]);
    expect(months[1]!.bottom).toEqual([
      { label: 'Net performance', value: '(44,080.00)', loss: true },
      { label: 'GP %', value: '42.4%' },
      { label: 'Net margin', value: '-842.8%', loss: true },
    ]);
    draw();
    expect(screen.getByText(/^Sales, cost and expenses/)).toBeTruthy();
  });
});
