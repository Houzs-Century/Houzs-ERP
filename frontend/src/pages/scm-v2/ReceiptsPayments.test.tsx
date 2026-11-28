/* The Cash Flow tab (owner 2026-09-06/07, named 2026-09-18), in the owner's
   Claude Design (batch 6, step 4): Total for every money account by default,
   the Accounts picker adding an account's own column beside it, the tree's top
   categories as sections with their own subtotal names, a running subtotal as
   a bold line, the unassigned groups last, then Cash surplus / (deficit),
   Balance b/f and Balance c/f, each split into Bank and Card; rows in the owner's
   accounts or by debtor / creditor; By month one read per column; a figure
   opens the entries behind it under its row; By month with the P&L forecast
   beside each month. The server half is backend/tests/rpReport.test.ts and
   backend/tests/cashFlowForecast.test.ts. */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpReport } from '../../vendor/scm/lib/rp-report-queries';
import type { LaidNode } from '../../vendor/scm/lib/report-layout';

const line = (key: string, code: string, label: string, cells: Record<string, number>, pct: number, flow: 'in' | 'out' = 'out'): LaidNode =>
  ({ kind: 'account', id: `${flow}:acc:${key}`, label, code, key, flow, amountSen: Object.values(cells).reduce((s, v) => s + v, 0), pct, cells, children: [] });

const report: RpReport = {
  from: '2026-07-01', to: '2026-07-31', byParty: false,
  columns: [{ code: '310-0010', name: 'CASH AT BANK - MAYBANK' }, { code: '320-0000', name: 'CASH IN HAND' }, { code: 'CARD', name: 'Card money not yet in the bank' }],
  opening: { '310-0010': -12000, '320-0000': 0, CARD: 2000 },
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
    closing: { '310-0010': -34000, '320-0000': 14000, CARD: 4000 }, openingTotalSen: -10000, receiptsTotalSen: 70000, paymentsTotalSen: 76000, closingTotalSen: -16000,
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
const shownReport = { value: null as RpReport | null };

vi.mock('../../vendor/scm/lib/rp-report-queries', async (importOriginal) => ({
  ...(await importOriginal() as object),
  useRpReport: (from: string, to: string, accounts: string[], byParty: boolean) => {
    lastRead.value = `${from}|${to}|${accounts.join(',')}|${byParty}`;
    return from ? { data: shownReport.value ?? report, isLoading: false, isError: false } : { data: undefined, isLoading: false, isError: false };
  },
}));
const columnPaths = vi.hoisted(() => [] as string[]);
const forecastAnswer = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({
  authedFetch: async (path: string) => {
    columnPaths.push(path);
    if (path.includes('/cash-flow-forecast/tf')) {
      return { currentMonth: '2026-07', shown: ['2026-07'], suppliers: [], facilities: [{
        code: '460-0009', name: 'TRADE FINANCE - SAMPLE BANK', lender: 'SAMPLE BANK', tenorSet: null, rateSet: null, tenorDays: 60, rateBp: 50, defaultRateBp: 50,
        interest: null, owedNowSen: 100000, open: [], suppliers: [], off: {}, dues: {}, schedule: [],
      }] };
    }
    if (path.includes('/cash-flow-forecast/inputs')) {
      return { currentMonth: '2026-07', shown: ['2026-07'], months: {}, notOffered: [], accounts: [{ code: '202-1000', name: 'EQUIPMENT (OFFICE)', group: { id: 'cf:funding:capex', label: 'CAPITAL EXPENDITURE (CAPEX)' } }] };
    }
    if (path.includes('/cash-flow-forecast')) return forecastAnswer.value;
    return shownReport.value ?? report;
  },
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
  window.localStorage.removeItem('fin-statement-codes');
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
    /* Each balance in two parts (owner 2026-11-05): the banks, which agree with the bank
       statements, and the card money not yet in the bank. */
    expect(screen.getAllByText('Bank').map((e) => e.closest('tr')?.textContent)).toEqual([expect.stringContaining('(120.00)'), expect.stringContaining('(200.00)')]);
    expect(screen.getAllByText('Card money not yet in the bank').flatMap((e) => (e.closest('tr') ? [e.closest('tr')!.textContent] : []))).toEqual([expect.stringContaining('20.00'), expect.stringContaining('40.00')]);
    /* The tree (docs/bugs/0912): the category with its per-column subtotal and its % of the side. */
    /* Open, its figures sit on its Total line below its rows (owner 2026-11-05). */
    const purchases = screen.getByText('Purchases').closest('tr')!;
    expect(purchases.getAttribute('data-kind')).toBe('category');
    expect(purchases.textContent).not.toContain('400.00');
    /* Its one line prints the same figures, so no Total line repeats them (owner 2026-11-27). */
    expect(screen.queryByText('Total Purchases')).toBeNull();
    const sofa = screen.getByText('PURCHASE OF SOFA').closest('tr')!;
    expect(sofa.textContent).toContain('400.00');
    expect(sofa.textContent).toContain('52.6%');
    expect(within(sofa).queryByText('601-0003')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Purchases' }));
    fireEvent.click(screen.getByRole('button', { name: /^Purchases · Total/ }));
    expect(screen.getByRole('region', { name: 'Entries of Purchases' }).textContent).toContain('Total · 1 entry');
    fireEvent.click(within(screen.getByRole('group', { name: 'Show debtor and creditor names' })).getByRole('button', { name: 'By debtor / creditor' }));
    expect(lastRead.value.endsWith('|true')).toBe(true);
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
    expect(screen.getByText('UTILITIES')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Levels' })).getByRole('button', { name: 'All' }));
    expect(screen.getByText('PURCHASE OF SOFA')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · Receipts & Payments' })).toBeTruthy();
  });
});

/* Owner 2026-11-09 (his Receipt & Payment workbook: 「就是一行settlement一行deposit」): each month as
   Settlement | Deposit, as the server split each line; a line not split runs one figure across the
   month; a split running subtotal gets its two figures added up under it. */
describe('Settlement / Deposit on the Cash Flow', () => {
  const sd = (settlementSen: number, depositSen: number) => ({ settlementSen, depositSen });
  const withSd = (n: LaidNode, pair: ReturnType<typeof sd> | null, kids?: LaidNode[]): LaidNode =>
    ({ ...n, ...(pair ? { sd: pair } : {}), children: kids ?? n.children });
  const [rin, rout, unassigned] = report.layout.tree as [LaidNode, LaidNode, LaidNode];
  const [ca] = rin.children as [LaidNode];
  const [ar, xfer] = ca.children as [LaidNode, LaidNode];
  const [purchases, utilities] = rout.children as [LaidNode, LaidNode];
  const split: RpReport = {
    ...report,
    layout: {
      ...report.layout,
      tree: [
        withSd(rin, sd(20_000, 50_000), [withSd(ca, sd(20_000, 50_000), [withSd(ar, sd(0, 50_000)), withSd(xfer, sd(20_000, 0))])]),
        withSd(rout, sd(42_000, 4_000), [withSd(purchases, sd(40_000, 0), [withSd(purchases.children[0]!, sd(40_000, 0))]), withSd(utilities, sd(2_000, 4_000))]),
        { kind: 'subtotal', id: 'sub:ops', label: 'NET OPERATION SURPLUS / (DEFICIT)', amountSen: 24_000, pct: null, sd: sd(-22_000, 46_000), children: [] },
        unassigned,
      ],
    },
  };
  beforeEach(() => { shownReport.value = split; });
  afterEach(() => { shownReport.value = null; });
  const openSplit = async () => {
    at();
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns' })).getByRole('button', { name: 'Settlement / Deposit' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Months' })).getByRole('button', { name: '3' }));
    await waitFor(() => expect(heads()).toEqual(['Account', 'Total3 months%', 'Jul 2026', 'Jun 2026', 'May 2026', 'Settlement', 'Deposit', 'Settlement', 'Deposit', 'Settlement', 'Deposit']));
  };
  const cells = (name: string) => [...screen.getByText(name).closest('tr')!.querySelectorAll('td')].map((td) => [td.textContent, td.getAttribute('colspan')]);

  test('each month as Settlement | Deposit under the month; Total whole with its %; one read per month', async () => {
    await openSplit();
    expect(columnPaths.some((p) => p.includes('from=2026-06-01&to=2026-06-30'))).toBe(true);
    /* The customer's deposit: nothing under Settlement (an empty cell, owner 2026-11-10), the money
       under Deposit. (Total is its own read of the three months; this mock answers every read with
       the one report.) */
    expect(cells('ACCOUNT RECEIVEABLE')).toEqual([['500.0071.4%', null], ...Array(3).fill(['', null]).flatMap((empty) => [empty, ['500.00', null]])]);
    expect(cells('UTILITIES').slice(1, 3)).toEqual([['20.00', null], ['40.00', null]]);
    expect(cells('Supplier advances (预付)')).toEqual([['300.0039.5%', null], ['300.00', '2'], ['300.00', '2'], ['300.00', '2']]);
  });

  test('a split running subtotal shows its two figures, then Settlement + Deposit under it', async () => {
    await openSplit();
    expect(cells('NET OPERATION SURPLUS / (DEFICIT)').slice(1, 3)).toEqual([['(220.00)', null], ['460.00', null]]);
    const sum = screen.getByText('Settlement + Deposit').closest('tr')!;
    expect(sum.getAttribute('data-kind')).toBe('memo');
    expect(cells('Settlement + Deposit').slice(1)).toEqual([['240.00', '2'], ['240.00', '2'], ['240.00', '2']]);
  });

  test('a figure across a month opens that month’s entries; a Settlement or Deposit share does not open', async () => {
    await openSplit();
    expect(screen.queryByRole('button', { name: 'UTILITIES · Jul 2026 Settlement' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Supplier advances (预付) · Jul 2026' })[0]!);
    expect(screen.getByRole('region', { name: 'Entries of Supplier advances (预付)' }).textContent).toContain('Jul 2026 · 1 entry');
  });

  test('Excel carries the months over their two columns and the figures run across as on the screen', async () => {
    await openSplit();
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [xs, name] = xlsx.mock.calls[0]! as [{ tables: Array<{ columns: Array<{ label: string; group?: string }>; rows: Array<{ label: string; cells: unknown[]; spans?: Record<number, number> }> }> }, string];
    expect(name).toBe('cash-flow-settlement-deposit-2026-05-2026-07.xlsx');
    expect(xs.tables[0]!.columns.map((c) => `${c.group ?? ''}|${c.label}`)).toEqual([
      '|Total', '|%', 'Jul 2026|Settlement', 'Jul 2026|Deposit', 'Jun 2026|Settlement', 'Jun 2026|Deposit', 'May 2026|Settlement', 'May 2026|Deposit',
    ]);
    expect(xs.tables[0]!.rows.find((r) => r.label === 'Supplier advances (预付)')!.spans).toEqual({ 2: 2, 4: 2, 6: 2 });
  });
});

/* Owner 2026-11-08: 可以帮我注明是从auto count带过来的吗？ Customers' money AutoCount recorded after the
   books started posts no journal; the Cash Flow names it below the customer receipts, grey, in no total,
   and its figure opens the payments behind it. */
describe('AutoCount money on the Cash Flow', () => {
  const customer = (key: string, label: string, sen: number) => line(key, '300-0000', label, { '310-0010': sen }, 0, 'in');
  const withAutoCount: RpReport = {
    ...report,
    autoCount: {
      sen: 54608600, count: 2,
      entries: [
        { jeNo: '', entryDate: '2026-07-01', sourceType: 'AUTOCOUNT', sourceDocNo: 'HC-SO-013406', narration: 'DATE NOT OBSERVED', party: 'TAN AH KOW', side: 'R', rowKey: 'AUTOCOUNT', column: 'AUTOCOUNT', sen: 204000 },
        { jeNo: '', entryDate: '2026-07-02', sourceType: 'AUTOCOUNT', sourceDocNo: 'HC-SO-013410', narration: null, party: 'LIM AH BENG', side: 'R', rowKey: 'AUTOCOUNT', column: 'AUTOCOUNT', sen: 54404600 },
      ],
    },
    layout: {
      ...report.layout,
      tree: [
        { ...report.layout.tree[0]!, children: [
          { kind: 'category', id: 'in:cat:deposit', label: 'DEPOSIT RECEIVED', amountSen: 50000, pct: 71.4, cells: { '310-0010': 50000 }, children: [
            customer('300-0000:DEP:CASH', 'Deposit · Transfer / cash', 30000),
            customer('300-0000:BAL:CASH', 'Balance · Transfer / cash', 20000),
          ] },
          line('XFER:310-0010', '310-0010', 'Transfer from 310-0010 · CASH AT BANK - MAYBANK', { '320-0000': 20000 }, 28.6, 'in'),
        ] },
        ...report.layout.tree.slice(1),
      ],
    },
  };
  const memoText = 'From AutoCount, not in the books';
  afterEach(() => { shownReport.value = null; });

  test('it prints right below the customer receipts’ own total, grey, and Total receipts does not count it', () => {
    shownReport.value = withAutoCount;
    at();
    const memo = screen.getByText(memoText).closest('tr')!;
    expect(memo.getAttribute('data-kind')).toBe('memo');
    expect(memo.textContent).toContain('546,086.00');
    const rows = screen.getAllByRole('row').map((r) => String(r.textContent));
    expect(rows.findIndex((t) => t.includes(memoText))).toBe(rows.findIndex((t) => t.startsWith('Total DEPOSIT RECEIVED')) + 1);
    expect(screen.getByText('Total receipts').closest('tr')!.textContent).toContain('700.00');
    shownReport.value = null;
  });

  test('its figure opens the payments AutoCount recorded', () => {
    shownReport.value = withAutoCount;
    at();
    fireEvent.click(screen.getByRole('button', { name: `${memoText} · Total` }));
    const region = screen.getByRole('region', { name: `Entries of ${memoText}` });
    expect(region.textContent).toContain('Total · 2 entries');
    expect(within(region).getByText(/AutoCount HC-SO-013406/)).toBeTruthy();
    expect(within(region).getByText('TAN AH KOW')).toBeTruthy();
    shownReport.value = null;
  });

  test('PDF carries it as the screen shows it', async () => {
    shownReport.value = withAutoCount;
    at();
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(pdf).toHaveBeenCalledTimes(1));
    const [sheet] = pdf.mock.calls[0]! as [Sheet];
    const rows = sheet.tables[0]!.rows as Array<{ label: string; depth: number; kind: string }>;
    const idx = rows.findIndex((x) => x.label === memoText);
    expect(rows[idx - 1]!.label).toBe('Balance · Transfer / cash');
    expect(rows[idx]).toMatchObject({ kind: 'memo', depth: rows.find((x) => x.label === 'DEPOSIT RECEIVED')!.depth });
    shownReport.value = null;
  });

  test('By month: each month’s own figure, the line where the Total view has it', async () => {
    shownReport.value = withAutoCount;
    at();
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns' })).getByRole('button', { name: 'By month' }));
    await waitFor(() => expect(screen.getAllByText(memoText).length).toBeGreaterThan(0));
    expect(screen.getByText(memoText).closest('tr')!.textContent).toContain('546,086.00');
    shownReport.value = null;
  });

  test('no AutoCount money, no line', () => {
    at();
    expect(screen.queryByText(memoText)).toBeNull();
  });
});

describe('the P&L forecast', () => {
  const fc = (month: string, tree: LaidNode[], inSen: number, outSen: number, entries: RpReport['entries'] = []): { month: string; future: boolean; report: RpReport } => ({
    month, future: month > '2026-07',
    report: {
      from: `${month}-01`, to: `${month}-28`, byParty: false,
      columns: [{ code: 'FORECAST', name: 'P&L forecast' }], opening: { FORECAST: 0 }, receipts: [], payments: [],
      totals: { receipts: { FORECAST: inSen }, payments: { FORECAST: outSen }, closing: { FORECAST: inSen - outSen }, openingTotalSen: 0, receiptsTotalSen: inSen, paymentsTotalSen: outSen, closingTotalSen: inSen - outSen },
      entries, card: { takingsSen: 0, transitSen: 0, codes: [] },
      layout: { stored: true, inSen, outSen, tree },
    },
  });
  const tree = (inSen: number, outSen: number): LaidNode[] => [
    { kind: 'category', id: 'side:in', label: 'RECEIPTS', flow: 'in', totalLabel: 'Total receipts', amountSen: inSen, pct: 100, cells: { FORECAST: inSen }, children: [
      { kind: 'category', id: 'in:sec:CURRENT ASSETS', label: 'CURRENT ASSETS', amountSen: inSen, pct: 100, cells: { FORECAST: inSen }, children: [
        line('300-0000:DEP:FC', '300-0000', 'Forecast sales', { FORECAST: inSen }, 100, 'in'),
      ] },
    ] },
    { kind: 'category', id: 'side:out', label: 'PAYMENTS', flow: 'out', totalLabel: 'Total payments', amountSen: outSen, pct: 100, cells: { FORECAST: outSen }, children: [
      { kind: 'category', id: 'out:cat:purchases', label: 'Purchases', amountSen: outSen, pct: 100, cells: { FORECAST: outSen }, children: [
        line('601-0003', '601-0003', '601-0003 · PURCHASE OF SOFA', { FORECAST: outSen }, 100),
      ] },
    ] },
  ];
  const ANSWER = {
    from: '2026-05', to: '2026-07', currentMonth: '2026-07',
    months: [
      fc('2026-05', [], 0, 0), fc('2026-06', [], 0, 0),
      fc('2026-07', tree(30000, 25000), 30000, 25000, [
        { jeNo: '', entryDate: '2026-07-01', sourceType: 'FORECAST', sourceDocNo: '2026-06', narration: 'Jun 2026 Forecast P&L · the supplier pays a month later (no payment term set)', party: 'Sample Sofa Works', side: 'P', rowKey: '601-0003', column: 'FORECAST', sen: 25000 },
      ]),
      fc('2026-08', tree(10000, 5000), 10000, 5000),
    ],
    measured: { from: '2026-04-01', to: '2026-06-30' },
    receiptMix: [{ kind: 'DEP', months: 0, pct: 70 }, { kind: 'BAL', months: 1, pct: 30 }],
    flagged: [{ id: 's1', code: '400-S001', name: 'Sample Sofa Works' }],
    nonCash: [],
    docs: null,
    tf: null,
  };
  beforeEach(() => { forecastAnswer.value = ANSWER; });
  afterEach(() => { forecastAnswer.value = null; });
  const cells = (name: string) => [...screen.getByText(name).closest('tr')!.querySelectorAll('td')].map((td) => td.textContent);
  const open = async () => {
    at();
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns' })).getByRole('button', { name: 'By month' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Months' })).getByRole('button', { name: '3' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Forecast' }));
    await waitFor(() => expect(heads()).toEqual([
      'Account', 'Total3 months%', 'Aug 2026Forecast only', 'Jul 2026', 'Jun 2026', 'May 2026',
      'P&L forecast', 'Actual', 'P&L forecast', 'Actual', 'P&L forecast', 'Actual', 'P&L forecast',
    ]));
  };

  test('each month Actual | P&L forecast, the later month the forecast alone; one read of the forecast for the months shown', async () => {
    await open();
    expect(columnPaths.filter((p) => p.includes('/cash-flow-forecast'))).toEqual(['/accounting/reports/cash-flow-forecast?from=2026-05&to=2026-07']);
    expect(cells('PURCHASE OF SOFA').slice(1)).toEqual(['50.00', '400.00', '250.00', '400.00', '', '400.00', '']);
    expect(cells('Forecast sales').slice(1)).toEqual(['100.00', '', '300.00', '', '', '', '']);
  });

  test('Balance b/f and c/f run on: a month from its own actual b/f, the later month from the forecast c/f before it', async () => {
    await open();
    expect(cells('Balance b/f').slice(1)).toEqual(['(50.00)', '(100.00)', '(100.00)', '(100.00)', '(100.00)', '(100.00)', '(100.00)']);
    expect(cells('Balance c/f').slice(1)).toEqual(['0.00', '(160.00)', '(50.00)', '(160.00)', '(100.00)', '(160.00)', '(100.00)']);
  });

  test('a forecast figure opens where it came from and how it was timed; the note names the supplier without a term', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: '601-0003 · PURCHASE OF SOFA · Jul 2026 P&L forecast' }));
    const region = screen.getByRole('region', { name: 'Entries of 601-0003 · PURCHASE OF SOFA' });
    expect(region.textContent).toContain('Jul 2026 P&L forecast · 1 entry');
    expect(region.textContent).toContain('Jun 2026');
    expect(region.textContent).toContain('Sample Sofa Works');
    expect(region.textContent).toContain('a month later (no payment term set)');
    expect(document.body.textContent).toContain('70% as deposits in the order month, 30% as settlements a month after');
    expect(document.body.textContent).toContain('No payment term on the supplier, counted a month later (1): Sample Sofa Works');
  });

  test('Capex & financing opens its table from By month', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Capex & financing' }));
    const dialog = await screen.findByRole('dialog', { name: 'Capex & financing' });
    expect(await within(dialog).findByText('CAPITAL EXPENDITURE (CAPEX)')).toBeTruthy();
    expect(within(dialog).getByLabelText('2026-07 202-1000 amount')).toBeTruthy();
  });

  const docsTree = (inSen: number): LaidNode[] => [
    { kind: 'category', id: 'side:in', label: 'RECEIPTS', flow: 'in', totalLabel: 'Total receipts', amountSen: inSen, pct: 100, cells: { FORECAST: inSen }, children: [
      { kind: 'category', id: 'in:sec:CURRENT ASSETS', label: 'CURRENT ASSETS', amountSen: inSen, pct: 100, cells: { FORECAST: inSen }, children: [
        line('300-0000:BAL:ORD', '300-0000', 'Open orders (balance on delivery)', { FORECAST: inSen }, 100, 'in'),
      ] },
    ] },
  ];
  const withDocs = () => ({
    ...ANSWER,
    docs: {
      months: [
        fc('2026-07', docsTree(20000), 20000, 0, [
          { jeNo: '', entryDate: '2026-07-01', sourceType: 'FORECAST_ORDER', sourceDocNo: 'SO-0001', narration: 'delivery 2026-07-20 · balance on delivery', party: 'Customer One', side: 'R', rowKey: '300-0000:BAL:ORD', column: 'FORECAST', sen: 20000 },
        ]),
        fc('2026-08', docsTree(5000), 5000, 0),
      ],
      asAt: '2026-07-01',
      undated: [{ year: '2026', orders: 2, sen: 150000 }],
      beyond: { orders: 0, orderSen: 0, bills: 0, billSen: 0 },
      flagged: [],
    },
  });

  test('Orders & bills from the current month on: Actual | Orders & bills | P&L forecast; an order opens behind its figure; the orders in no month are said', async () => {
    forecastAnswer.value = withDocs();
    at();
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns' })).getByRole('button', { name: 'By month' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Months' })).getByRole('button', { name: '3' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Forecast' }));
    await waitFor(() => expect(heads()).toEqual([
      'Account', 'Total3 months%', 'Aug 2026Forecast only', 'Jul 2026', 'Jun 2026', 'May 2026',
      'Orders & bills', 'P&L forecast', 'Actual', 'Orders & bills', 'P&L forecast', 'Actual', 'P&L forecast', 'Actual', 'P&L forecast',
    ]));
    expect(cells('Open orders (balance on delivery)').slice(1)).toEqual(['50.00', '', '', '200.00', '', '', '', '', '']);
    fireEvent.click(screen.getByRole('button', { name: 'Open orders (balance on delivery) · Jul 2026 Orders & bills' }));
    const region = screen.getByRole('region', { name: 'Entries of Open orders (balance on delivery)' });
    expect(region.textContent).toContain('Order SO-0001');
    expect(region.textContent).toContain('Customer One');
    expect(region.textContent).toContain('delivery 2026-07-20');
    expect(document.body.textContent).toContain('Open orders with no delivery date, in no month (2): 2 ordered in 2026, RM 1,500.00.');
  });

  test('Trade finance opens its plan from By month', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Trade finance' }));
    const dialog = await screen.findByRole('dialog', { name: 'Trade finance' });
    expect(await within(dialog).findByText('460-0009 · TRADE FINANCE - SAMPLE BANK')).toBeTruthy();
    expect(within(dialog).getByText('Owed today RM 1,000.00')).toBeTruthy();
  });

  test('by debtor / creditor the forecast steps aside; Excel carries the forecast columns as shown', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [xs, name] = xlsx.mock.calls[0]! as [{ tables: Array<{ columns: Array<{ label: string; group?: string }> }> }, string];
    expect(name).toBe('cash-flow-monthly-forecast-2026-05-2026-07.xlsx');
    expect(xs.tables[0]!.columns.map((c) => `${c.group ?? ''}|${c.label}`).slice(0, 5)).toEqual(['|Total', '|%', 'Aug 2026|P&L forecast', 'Jul 2026|Actual', 'Jul 2026|P&L forecast']);
    fireEvent.click(within(screen.getByRole('group', { name: 'Show debtor and creditor names' })).getByRole('button', { name: 'By debtor / creditor' }));
    await waitFor(() => expect(heads()).toEqual(['Account', 'Total3 months%', 'Jul 2026%', 'Jun 2026%', 'May 2026%']));
    expect(screen.getByRole('switch', { name: 'Forecast' }).getAttribute('aria-checked')).toBe('false');
  });
});
