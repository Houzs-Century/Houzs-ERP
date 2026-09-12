/* The Performance P&L tab (owner 2026-09-12, docs/bugs/0835): a row per
   group with sales, cost, gross profit and %; the summary from gross profit
   through the computed operating expense (named for the account it stands
   in for) and the booked expenses to net; the notes; the rate and account
   saved from the strip; the CSV off the same lines. The server half is
   backend/tests/performanceReport.test.ts. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { PerformanceReport } from '../../vendor/scm/lib/performance-report-queries';

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
  otherExpenses: [
    { code: '900-A014', name: 'ADVERTISEMENT - SHOWROOM', amountSen: 100000 },
    { code: '900-R048', name: 'RENTAL OF SHOWROOM', amountSen: 4500000 },
  ],
  otherExpensesSen: 4600000,
  netSen: -4458000, netPct: -852.4,
  settings: { rateBp: 1600, account: '900-O001' },
};
const lastPath = { value: '' };
const saveMutate = vi.fn();
const pdfMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../vendor/scm/lib/performance-report-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  usePerformanceReport: (from: string, to: string) => { lastPath.value = `${from}|${to}`; return { data: report, isLoading: false, isError: false, error: null }; },
  useSavePerformanceSettings: () => ({ mutate: saveMutate, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/performance-pnl-pdf', () => ({ generatePerformancePdf: pdfMock }));

const { PerformanceTab, performanceCsv } = await import('./PerformancePnl');

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
    expect(within(opex).getByText('(800.00)')).toBeTruthy();
    expect(screen.getByText('900-R048 · RENTAL OF SHOWROOM')).toBeTruthy();
    const net = rows.find((r) => within(r).queryByText('NET PERFORMANCE'))!;
    expect(within(net).getByText('(44,580.00)')).toBeTruthy();
    expect(within(net).getByText('-852.4% of sales')).toBeTruthy();
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
    expect(pdfMock).toHaveBeenCalledWith(report);
  });

  test('the CSV carries the groups, the summary and the notes', () => {
    const csv = performanceCsv(report);
    expect(csv).toContain('Group,Sales,Cost of sales,Gross profit,GP %');
    expect(csv).toContain('Sofa,"3,000.00","1,800.00","1,200.00",40.0%');
    expect(csv).toContain('Accessory,0.00,120.00,(120.00),—');
    expect(csv).toContain('Total,"5,230.00","3,010.00","2,220.00",42.4%');
    expect(csv).toContain('"Operating expense — 16.00% of sales excluding service (5,000.00), in place of 900-O001 OPERATIING EXPENSE",(800.00)');
    expect(csv).toContain('NET PERFORMANCE,"(44,580.00)",-852.4% of sales');
    expect(csv).toContain('Notes');
    expect(csv).toContain('in place of account 900-O001');
  });
});
