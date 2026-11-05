/* The Cash Flow tab (owner 2026-09-06/07, named 2026-09-18), in the owner's
   Claude Design (batch 6, step 4): Total for every money account by default,
   the Accounts picker adding an account's own column beside it, the tree's top
   categories as sections with their own subtotal names, a running subtotal as
   a bold line, the unassigned groups last, then Cash surplus / (deficit),
   Balance b/f and Balance c/f and the card memo lines; rows in the owner's
   accounts or by debtor / creditor; By month one read per column; a figure
   opens the entries behind it under its row. The server half is
   backend/tests/rpReport.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpReport } from '../../vendor/scm/lib/rp-report-queries';
import type { LaidNode } from '../../vendor/scm/lib/report-layout';

const line = (key: string, code: string, label: string, cells: Record<string, number>, pct: number, flow: 'in' | 'out' = 'out'): LaidNode =>
  ({ kind: 'account', id: `${flow}:acc:${key}`, label, code, key, flow, amountSen: Object.values(cells).reduce((s, v) => s + v, 0), pct, cells, children: [] });

const report: RpReport = {
  from: '2026-07-01', to: '2026-07-31', byParty: false,
  columns: [{ code: '310-0010', name: 'CASH AT BANK - MAYBANK' }, { code: '320-0000', name: 'CASH IN HAND' }],
  opening: { '310-0010': -10000, '320-0000': 0 },
  receipts: [
    { key: '300-0000', code: '300-0000', name: 'ACCOUNT RECEIVEABLE', cells: { '310-0010': 50000 }, totalSen: 50000 },
    { key: 'XFER:310-0010', code: '310-0010', name: 'Transfer from 310-0010 · CASH AT BANK - MAYBANK', cells: { '320-0000': 20000 }, totalSen: 20000 },
  ],
  payments: [
    { key: '601-0003', code: '601-0003', name: 'PURCHASE OF SOFA', cells: { '310-0010': 40000 }, totalSen: 40000 },
    { key: 'ADV', code: null, name: 'Supplier advances (预付)', cells: { '310-0010': 30000 }, totalSen: 30000 },
    { key: '910-0000', code: '910-0000', name: 'UTILITIES', cells: { '320-0000': 6000 }, totalSen: 6000 },
  ],
  totals: {
    receipts: { '310-0010': 50000, '320-0000': 20000 }, payments: { '310-0010': 70000, '320-0000': 6000 },
    closing: { '310-0010': -30000, '320-0000': 14000 }, openingTotalSen: -10000, receiptsTotalSen: 70000, paymentsTotalSen: 76000, closingTotalSen: -16000,
  },
  card: { takingsSen: 12345, transitSen: 67890, codes: ['326-0000', '326-0010'] },
  entries: [
    { jeNo: 'JE-1', entryDate: '2026-07-05', sourceType: 'SOPAY', sourceDocNo: 'pay-1', narration: null, party: 'Ah Meng', side: 'R', rowKey: '300-0000', column: '310-0010', sen: 50000 },
    { jeNo: 'JE-3', entryDate: '2026-07-15', sourceType: 'PV', sourceDocNo: 'PV-3', narration: null, party: 'FOSHAN CHAIRS', side: 'P', rowKey: '601-0003', column: '310-0010', sen: 40000 },
    { jeNo: 'JE-3', entryDate: '2026-07-15', sourceType: 'PV', sourceDocNo: 'PV-3', narration: null, party: 'FOSHAN CHAIRS', side: 'P', rowKey: 'ADV', column: '310-0010', sen: 30000 },
  ],
  /* The rows on the Cash Flow tree (docs/bugs/0912): RECEIPTS (In) and
     PAYMENTS (Out) with their own subtotal names; the owner's "Purchases"
     holds the sofa row; the advance was never placed, so it prints under
     Unassigned payments, last. */
  layout: {
    stored: true, inSen: 70000, outSen: 76000,
    tree: [
      { kind: 'category', id: 'side:in', label: 'RECEIPTS', flow: 'in', totalLabel: 'Total receipts', amountSen: 70000, pct: 100, cells: { '310-0010': 50000, '320-0000': 20000 }, children: [
        { kind: 'category', id: 'in:sec:CURRENT ASSETS', label: 'CURRENT ASSETS', amountSen: 70000, pct: 100, cells: { '310-0010': 50000, '320-0000': 20000 }, children: [
          line('300-0000', '300-0000', '300-0000 · ACCOUNT RECEIVEABLE', { '310-0010': 50000 }, 71.4, 'in'),
          line('XFER:310-0010', '310-0010', 'Transfer from 310-0010 · CASH AT BANK - MAYBANK', { '320-0000': 20000 }, 28.6, 'in'),
        ] },
      ] },
      { kind: 'category', id: 'side:out', label: 'PAYMENTS', flow: 'out', totalLabel: 'Total payments', amountSen: 46000, pct: 60.5, cells: { '310-0010': 40000, '320-0000': 6000 }, children: [
        { kind: 'category', id: 'out:cat:purchases', label: 'Purchases', amountSen: 40000, pct: 52.6, cells: { '310-0010': 40000 }, children: [
          line('601-0003', '601-0003', '601-0003 · PURCHASE OF SOFA', { '310-0010': 40000 }, 52.6),
        ] },
        line('910-0000', '910-0000', '910-0000 · UTILITIES', { '320-0000': 6000 }, 7.9),
      ] },
      { kind: 'unassigned', id: 'unassigned:out', label: 'Unassigned payments', flow: 'out', totalLabel: 'Total unassigned payments', amountSen: 30000, pct: 39.5, cells: { '310-0010': 30000 }, children: [
        line('ADV', 'ADV', 'Supplier advances (预付)', { '310-0010': 30000 }, 39.5),
      ] },
    ],
  },
};
const lastRead = { value: '' };

vi.mock('../../vendor/scm/lib/rp-report-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useRpReport: (from: string, to: string, accounts: string[], byParty: boolean) => {
    lastRead.value = `${from}|${to}|${accounts.join(',')}|${byParty}`;
    return from ? { data: report, isLoading: false, isError: false } : { data: undefined, isLoading: false, isError: false };
  },
}));
/* By month: each column one read of the same endpoint. */
const columnPaths = vi.hoisted(() => [] as string[]);
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: async (path: string) => { columnPaths.push(path); return report; },
}));
vi.mock('../../vendor/scm/lib/dashboard-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useFinanceDashboard: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock('../../vendor/scm/lib/accounting-queries', () => ({
  useAccounts: () => ({ data: { accounts: [
    { account_code: '310-0010', account_name: 'CASH AT BANK - MAYBANK', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '320-0000', account_name: 'CASH IN HAND', account_type: 'ASSET', is_active: true, acc_money: true },
    { account_code: '910-0000', account_name: 'UTILITIES', account_type: 'EXPENSE', is_active: true, acc_money: false },
  ] }, isLoading: false }),
}));
const xlsx = vi.fn(async (..._a: unknown[]) => {});
const pdf = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: (...a: unknown[]) => pdf(...a) }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('./ReportLayoutEditor', () => ({ ReportLayoutEditor: () => <div role="dialog" aria-label="Layout · Receipts & Payments">editor</div> }));

import { ReceiptsPaymentsTab, cashChartMonth } from './ReceiptsPayments';
import type { DashboardPeriod } from '../../vendor/scm/lib/dashboard-queries';

const JULY = '/scm/accounting?tab=rp&from=2026-07-01&to=2026-07-31';
const at = (url = JULY) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><ReceiptsPaymentsTab /></MemoryRouter>
  </QueryClientProvider>,
);
const heads = () => screen.getAllByRole('columnheader').map((h) => h.textContent);
const pick = (code: string) => {
  fireEvent.click(screen.getByRole('button', { name: /^Total (only|\+)/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: `Column ${code}` }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
};
type Sheet = { title: string; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string }> }> };

beforeEach(() => {
  columnPaths.length = 0;
  xlsx.mockClear();
  pdf.mockClear();
  window.localStorage.removeItem('fin-reports-colw-v2');
});

describe('the Cash Flow tab', () => {
  test('Total alone by default, the Accounts picker adds an account’s own column; receipts above payments, each section its own subtotal name, the foot and the card memo lines', () => {
    at();
    /* Total alone by default (owner 2026-09-18: default 看 total). */
    expect(heads()).toEqual(['Account', 'TotalEvery bank and cash account%']);
    expect(screen.getByRole('button', { name: 'Total only' })).toBeTruthy();
    pick('310-0010');
    expect(heads()).toEqual(['Account', '310-0010CASH AT BANK - MAYBANK', 'TotalEvery bank and cash account%']);
    expect(screen.getByRole('button', { name: 'Total + CASH AT BANK - MAYBANK' })).toBeTruthy();
    expect(screen.getByText('RECEIPTS')).toBeTruthy();
    expect(screen.getByText('PAYMENTS')).toBeTruthy();
    expect(screen.getByText('Total receipts').closest('tr')!.textContent).toContain('700.00');
    expect(screen.getByText('Total payments').closest('tr')!.textContent).toContain('460.00');
    expect(screen.getByText('Total unassigned payments').closest('tr')!.textContent).toContain('300.00');
    /* The foot (owner 2026-09-18): Cash surplus / (deficit) = receipts − payments, its % of the receipts; then b/f and c/f. */
    const surplus = screen.getByText('Cash surplus / (deficit)').closest('tr')!;
    expect(surplus.textContent).toContain('(60.00)');
    expect(surplus.textContent).toContain('-8.6%');
    expect(screen.getByText('Balance b/f').closest('tr')!.textContent).toContain('(100.00)');
    const closing = screen.getByText('Balance c/f').closest('tr')!;
    expect(closing.textContent).toContain('(160.00)');
    expect(closing.className).toMatch(/rowFinal/);
    /* The card money the bank has not received (owner 2026-09-28): Total column only. */
    expect(screen.getByText('Card takings this period (swiped, not yet in the bank)').closest('tr')!.textContent).toContain('123.45');
    expect(screen.getByText('Card money in transit at period end').closest('tr')!.textContent).toContain('678.90');
    /* The tree (docs/bugs/0912): the category with its per-column subtotal and its % of the side. */
    /* Open, its figures sit on its Total line below its rows (owner 2026-11-05). */
    const purchases = screen.getByText('Purchases').closest('tr')!;
    expect(purchases.getAttribute('data-kind')).toBe('category');
    expect(purchases.textContent).not.toContain('400.00');
    const purchasesTotal = screen.getByText('Total Purchases').closest('tr')!;
    expect(purchasesTotal.textContent).toContain('400.00');
    expect(purchasesTotal.textContent).toContain('52.6%');
    const sofa = screen.getByText('PURCHASE OF SOFA').closest('tr')!;
    expect(within(sofa).getByText('601-0003')).toBeTruthy();
    expect(sofa.getAttribute('data-depth')).toBe('2');
    expect(screen.getByText('Supplier advances (预付)').closest('tr')!.textContent).toContain('39.5%');
    expect(screen.getByText('Total payments').closest('tr')!.textContent).toContain('60.5%');
  });

  test('a figure opens the entries behind it under its row — a category’s, every row under it; the rows toggle changes the read; a column never narrows it', () => {
    at();
    pick('310-0010');
    fireEvent.click(screen.getByRole('button', { name: '601-0003 · PURCHASE OF SOFA · 310-0010' }));
    const sofa = screen.getByRole('region', { name: 'Entries of 601-0003 · PURCHASE OF SOFA' });
    expect(sofa.textContent).toContain('310-0010 · 1 entry');
    expect(within(sofa).getByText('FOSHAN CHAIRS')).toBeTruthy();
    expect(within(sofa).getByText(/Payment voucher PV-3/)).toBeTruthy();
    /* The category's total: the sofa row's entry, and it alone here. */
    fireEvent.click(screen.getByRole('button', { name: /^Total Purchases · Total/ }));
    expect(screen.getByRole('region', { name: 'Entries of Purchases' }).textContent).toContain('Total · 1 entry');
    fireEvent.click(within(screen.getByRole('group', { name: 'Show debtor and creditor names' })).getByRole('button', { name: 'By debtor / creditor' }));
    expect(lastRead.value.endsWith('|true')).toBe(true);
    /* A tick shows a column; the read itself still covers every account. */
    pick('320-0000');
    expect(heads()).toContain('320-0000CASH IN HAND');
    expect(lastRead.value).not.toContain('320-0000');
    expect(lastRead.value).not.toContain('310-0010');
  });

  test('Excel, PDF and Print carry the report, its picked columns and its fold (owner 2026-09-19: 显示什么就 export 什么)', async () => {
    at();
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(pdf).toHaveBeenCalledTimes(1));
    const [sheet, opts] = pdf.mock.calls[0]! as [Sheet, { fileName: string; action: string }];
    expect(sheet.title).toBe('Cash Flow');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Total', '%']);
    expect(opts).toEqual({ fileName: 'cash-flow-2026-07-01-to-2026-07-31.pdf', action: 'preview' });
    pick('310-0010');
    fireEvent.click(within(screen.getByRole('group', { name: 'Levels' })).getByRole('button', { name: 'L1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [xs, name] = xlsx.mock.calls[0]! as [Sheet, string];
    expect(name).toBe('cash-flow-2026-07-01-to-2026-07-31.xlsx');
    expect(xs.tables[0]!.columns.map((c) => c.label)).toEqual(['310-0010 CASH AT BANK - MAYBANK', 'Total', '%']);
    expect(xs.tables[0]!.rows.map((r) => r.label)).not.toContain('601-0003 · PURCHASE OF SOFA');
    fireEvent.click(screen.getByRole('switch', { name: '% beside' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(pdf).toHaveBeenCalledTimes(2));
    expect((pdf.mock.calls[1]![0] as Sheet).tables[0]!.columns.map((c) => c.label)).toEqual(['310-0010 CASH AT BANK - MAYBANK', 'Total']);
    expect(pdf.mock.calls[1]![1]).toMatchObject({ action: 'print' });
  });

  test('By month: Total leftmost then each month, one read per column; the picker steps aside', async () => {
    at();
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns' })).getByRole('button', { name: 'By month' }));
    expect(screen.queryByRole('button', { name: /^Total (only|\+)/ })).toBeNull();
    fireEvent.click(within(screen.getByRole('group', { name: 'Months' })).getByRole('button', { name: '3' }));
    await waitFor(() => expect(heads()).toEqual(['Account', 'Total3 months%', 'Jul 2026%', 'Jun 2026%', 'May 2026%']));
    expect(columnPaths.some((p) => p.includes('from=2026-05-01&to=2026-07-31'))).toBe(true);
    expect(columnPaths.some((p) => p.includes('from=2026-06-01&to=2026-06-30'))).toBe(true);
    expect(screen.getByText('Cash surplus / (deficit)').closest('tr')!.textContent).toContain('(60.00)');
  });

  test('the chart’s month: money in and out as bars, the surplus or deficit under them and in its card', () => {
    const month = (cashFlow: unknown) => ({ cashFlow }) as unknown as DashboardPeriod;
    expect(cashChartMonth(month(null))).toBeNull();
    expect(cashChartMonth(month({ inSen: 7_000_000, outSen: 7_600_000, netSen: -600_000, openingSen: 0, closingSen: -600_000, tree: [] }))).toEqual({
      values: { in: 7_000_000, out: 7_600_000 },
      bottom: [{ label: 'Cash surplus / (deficit)', value: '(6,000.00)', loss: true }, { label: 'Balance c/f', value: '(6,000.00)' }],
      under: { text: '(6.0)', loss: true },
    });
  });

  test('L1 folds the rows to their categories; the Layout button opens the editor', () => {
    at();
    fireEvent.click(within(screen.getByRole('group', { name: 'Levels' })).getByRole('button', { name: 'L1' }));
    expect(screen.queryByText('PURCHASE OF SOFA')).toBeNull();
    expect(screen.getByText('Purchases').closest('tr')!.textContent).toContain('400.00');
    /* A row at the top level stays. */
    expect(screen.getByText('UTILITIES')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Levels' })).getByRole('button', { name: 'All' }));
    expect(screen.getByText('PURCHASE OF SOFA')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · Receipts & Payments' })).toBeTruthy();
  });
});
