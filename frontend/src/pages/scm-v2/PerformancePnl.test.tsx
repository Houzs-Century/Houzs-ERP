/* The Performance P&L tab (owner 2026-09-12, docs/bugs/0835): a row per
   group with sales, cost, gross profit and %; the summary from gross profit
   through the computed operating expense (named for the account it stands
   in for) and the booked expenses to net; the notes; the rate and account
   saved from the strip; Excel and PDF off the same lines. The server half is
   backend/tests/performanceReport.test.ts. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { PerformanceReport } from '../../vendor/scm/lib/performance-report-queries';
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
    { key: 'sofa', label: 'Sofa', lines: 1, salesSen: 300000, cogsSen: 180000, gpSen: 120000, gpPct: 40 },
    { key: 'dining', label: 'Dining', lines: 1, salesSen: 40000, cogsSen: 25000, gpSen: 15000, gpPct: 37.5 },
    { key: 'accessory', label: 'Accessory', lines: 1, salesSen: 0, cogsSen: 12000, gpSen: -12000, gpPct: null },
    { key: 'service', label: 'Service / transport income', lines: 1, salesSen: 23000, cogsSen: 0, gpSen: 23000, gpPct: 100 },
    { key: 'others', label: 'Others', lines: 1, salesSen: 10000, cogsSen: 4000, gpSen: 6000, gpPct: 60 },
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
  /* The account part on the tree (docs/bugs/0912): the computed operating
     expense sits where 900-O001 sits — inside the owner's "Fixed costs". */
  layout: {
    stored: true, baseSen: 523000,
    otherIncome: [acc('590-0000', '590-0000 — RENT RECEIVED', 50000, 9.6)],
    expenses: [
      { kind: 'category', id: 'cat:fixed', label: 'Fixed costs', amountSen: 4580000, pct: 875.7, children: [
        acc('900-R048', '900-R048 — RENTAL OF SHOWROOM', 4500000, 860.4),
        acc('900-O001', OPEX_LABEL, 80000, 15.3),
      ] },
      acc('900-A014', '900-A014 — ADVERTISEMENT - SHOWROOM', 100000, 19.1),
    ],
  },
};
const lastPath = { value: '' };
const saveMutate = vi.fn();
const pdfMock = vi.fn(async (..._args: unknown[]) => {});
const xlsxMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../vendor/scm/lib/performance-report-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  usePerformanceReport: (from: string, to: string) => { lastPath.value = `${from}|${to}`; return { data: report, isLoading: false, isError: false, error: null }; },
  useSavePerformanceSettings: () => ({ mutate: saveMutate, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/performance-pnl-pdf', () => ({ generatePerformancePdf: pdfMock, downloadPerformanceXlsx: xlsxMock }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./ReportLayoutEditor', () => ({ ReportLayoutEditor: () => <div role="dialog" aria-label="Layout · Performance P&L">editor</div> }));
/* The monthly view has its own contract (MonthlyReport.test.tsx); here it only has to be reached. */
vi.mock('./MonthlyReport', () => ({
  MonthlyReport: (p: { title: string; withCumulative: boolean }) => <div role="region" aria-label={`Monthly · ${p.title}`}>{p.withCumulative ? 'with 累计' : 'no 累计'}</div>,
  ByMonthButton: ({ on, onToggle }: { on: boolean; onToggle: () => void }) => <button type="button" aria-pressed={on} onClick={onToggle}>By month</button>,
}));

const { PerformanceTab } = await import('./PerformancePnl');

describe('the Performance P&L tab', () => {
  test('a row per group with sales, cost, gross profit and %; the total names the orders; the summary runs to net', () => {
    render(<PerformanceTab />);
    expect(lastPath.value).toMatch(/^\d{4}-\d{2}-01\|\d{4}-\d{2}-\d{2}$/);
    const rows = screen.getAllByRole('row');
    const sofa = rows.find((r) => within(r).queryByText(/^Sofa/))!;
    expect(within(sofa).getByText('3,000.00')).toBeTruthy();
    expect(within(sofa).getByText('1,800.00')).toBeTruthy();
    expect(within(sofa).getByText('1,200.00')).toBeTruthy();
    expect(within(sofa).getByText('40.0%')).toBeTruthy();
    const accessory = rows.find((r) => within(r).queryByText(/^Accessory/))!;
    expect(within(accessory).getByText('(120.00)')).toBeTruthy();
    expect(within(accessory).getByText('—')).toBeTruthy();
    const total = rows.find((r) => within(r).queryByText(/^Total/))!;
    expect(total.textContent).toContain('4 orders, 3 not yet delivered');
    expect(within(total).getByText('5,230.00')).toBeTruthy();
    expect(within(total).getByText('42.4%')).toBeTruthy();
    const opex = rows.find((r) => within(r).queryByText(/Operating expense/))!;
    expect(opex.textContent).toContain('16.00% of sales excluding service (5,000.00), in place of 900-O001 OPERATIING EXPENSE');
    /* SIGNS (docs/bugs/0910): an expense prints plain, with its % of sales
       in the GP % column; only a loss, or a line whose credits beat its
       debits, wears parentheses. */
    expect(within(opex).getByText('800.00')).toBeTruthy();
    expect(within(opex).getByText('15.3%')).toBeTruthy();
    expect(opex.querySelectorAll('td')).toHaveLength(3);   // label across the three group columns, then amount, then %
    expect(opex.querySelector('td')!.getAttribute('colspan')).toBe('3');
    /* LEVELS (docs/bugs/0912): the computed line sits INSIDE the owner's
       category, two deep; the category carries its subtotal and %. */
    expect(opex.getAttribute('data-depth')).toBe('2');
    const fixed = rows.find((r) => within(r).queryByText('Fixed costs'))!;
    expect(fixed.getAttribute('data-summary')).toBe('category');
    expect(within(fixed).getByText('45,800.00')).toBeTruthy();
    expect(within(fixed).getByText('875.7%')).toBeTruthy();
    expect(screen.getByText('900-R048 — RENTAL OF SHOWROOM')).toBeTruthy();
    const rent = rows.find((r) => within(r).queryByText('590-0000 — RENT RECEIVED'))!;
    expect(within(rent).getByText('500.00')).toBeTruthy();
    expect(within(rent).getByText('9.6%')).toBeTruthy();
    expect(screen.getByText('Total other income (as booked)')).toBeTruthy();
    /* The expenses total covers the tree — the computed line included. */
    const expenses = rows.find((r) => within(r).queryByText(/^Total expenses/))!;
    expect(expenses.textContent).toContain('operating expense at 16.00%');
    expect(within(expenses).getByText('46,800.00')).toBeTruthy();
    expect(within(expenses).getByText('894.8%')).toBeTruthy();
    const net = rows.find((r) => within(r).queryByText('NET PERFORMANCE'))!;
    expect(within(net).getByText('(44,080.00)')).toBeTruthy();
    expect(within(net).getByText('-842.8%')).toBeTruthy();
    const notes = screen.getByLabelText('Performance notes');
    expect(notes.textContent).toContain('in place of account 900-O001 OPERATIING EXPENSE; the 2,435.50 booked on that account in the period is left out');
    expect(notes.textContent).toContain('free gifts');
  });

  test('the strip saves the rate as basis points and the account; PDF prints the report', () => {
    render(<PerformanceTab />);
    const strip = screen.getByLabelText('Performance settings');
    const rate = within(strip).getByLabelText('Operating expense rate percent') as HTMLInputElement;
    expect(rate.value).toBe('16.00');
    expect((within(strip).getByLabelText('Operating expense account') as HTMLInputElement).value).toBe('900-O001');
    expect(within(strip).getByText('OPERATIING EXPENSE')).toBeTruthy();
    const saveBtn = within(strip).getByText('Save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.change(rate, { target: { value: '18' } });
    fireEvent.click(within(strip).getByText('Save'));
    expect(saveMutate.mock.calls[0]?.[0]).toEqual({ rateBp: 1800, account: '900-O001' });
    fireEvent.click(screen.getByText('PDF'));
    expect(pdfMock).toHaveBeenCalledWith(report, { level: 'all', open: {} });
  });

  test('L1 folds the account part to its categories, All opens it; the Layout button opens the editor', () => {
    render(<PerformanceTab />);
    expect(screen.getByRole('group', { name: 'Levels' }).textContent).toContain('L2');
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    expect(screen.queryByText(/^Operating expense — 16/)).toBeNull();
    expect(screen.queryByText('900-R048 — RENTAL OF SHOWROOM')).toBeNull();
    /* The category keeps its subtotal while folded; the fixed lines stay. */
    expect(screen.getByText('Fixed costs').closest('tr')!.textContent).toContain('45,800.00');
    expect(screen.getByText('900-A014 — ADVERTISEMENT - SHOWROOM')).toBeTruthy();
    expect(screen.getByText('NET PERFORMANCE')).toBeTruthy();
    /* At L1 the category still opens by its own chevron (owner: 按 Level 1 后我无法点开看子 account). */
    fireEvent.click(screen.getByRole('button', { name: 'Expand Fixed costs' }));
    expect(screen.getByText('900-R048 — RENTAL OF SHOWROOM')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Fixed costs' }));
    expect(screen.queryByText('900-R048 — RENTAL OF SHOWROOM')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText(/^Operating expense — 16/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · Performance P&L' })).toBeTruthy();
  });

  test('By month opens the monthly view with 累计 and puts the groups table away (docs/bugs/0916)', () => {
    render(<PerformanceTab />);
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    expect(screen.getByRole('region', { name: 'Monthly · Performance P&L' }).textContent).toBe('with 累计');
    expect(screen.queryByText('NET PERFORMANCE')).toBeNull();
    /* The settings strip stays — the rate applies to every month. */
    expect(screen.getByLabelText('Performance settings')).toBeTruthy();
  });

  test('Excel carries the tables as shown — folded to the level chosen (owner 2026-09-19: 显示什么就 export 什么)', () => {
    render(<PerformanceTab />);
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    fireEvent.click(screen.getByText('Excel'));
    expect(xlsxMock).toHaveBeenCalledWith(report, { level: 1, open: {} });
  });
});
