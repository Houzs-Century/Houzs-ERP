// The standard statements' screen (GL redesign item 6), in the owner's Claude
// Design (batch 6, step 2): the P&L renders the owner's sections with gross
// and net where they belong, and the balance sheet says BALANCED only when
// the self-check is zero. Since docs/bugs/0911 the P&L draws each block on the
// report's LAYOUT — category subtotals, % of sales on every row, L1..Ln — and
// offers the layout editor. The redesign adds the shared range in the
// address, Single / Compare / By month, "% beside", the lines opened under a
// row, the balance sheet's tiles, and Excel · PDF · Print in the header.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const acc = (code: string, name: string, amountSen: number, pct: number | null) =>
  ({ kind: 'account' as const, id: `acc:${code}`, label: `${code} · ${name}`, code, amountSen, pct, children: [] });
const pnlLayout = (sales: number) => ({
  stored: false,
  baseSen: sales,
  tradingIncome: [{ kind: 'category' as const, id: 'sec:SALES', label: 'SALES', amountSen: sales, pct: 100, children: [acc('501-0000', 'SALES', sales, 100)] }],
  costOfSales: [acc('601-0003', 'PURCHASE OF SOFA', 60_000, 60), acc('620-0000', 'STOCKS AT END', -10_000, -10)],
  otherIncome: [acc('590-0000', 'RENT RECEIVED', 5_000, 5)],
  expenses: [{
    kind: 'category' as const, id: 'acc:900-0000', label: 'Operating Expense', code: '900-0000', amountSen: 10_500, pct: 10.5,
    children: [
      acc('900-A001', 'ADVERT', 12_000, 12),
      { kind: 'category' as const, id: 'acc:900-A002', label: 'ADVERTISEMENT', code: '900-A002', amountSen: -1_500, pct: -1.5, children: [acc('900-A014', 'ADVERT - SHOWROOM', -1_500, -1.5)] },
    ],
  }],
  taxation: [acc('950-0000', 'TAXATION', 3_000, 3)],
});

const pnl = (sales: number) => ({
  tradingIncome: [{ code: '501-0000', name: 'SALES', amountSen: sales }],
  costOfSales: [{ code: '601-0003', name: 'PURCHASE OF SOFA', amountSen: 60_000 }, { code: '620-0000', name: 'STOCKS AT END', amountSen: -10_000 }],
  otherIncome: [{ code: '590-0000', name: 'RENT RECEIVED', amountSen: 5_000 }],
  expenses: [{ code: '900-A001', name: 'ADVERT', amountSen: 12_000 }, { code: '900-A014', name: 'ADVERT - SHOWROOM', amountSen: -1_500 }],
  taxation: [{ code: '950-0000', name: 'TAXATION', amountSen: 3_000 }],
  stock: { closingProvisional: true, asOf: '2026-10-31' },
  layout: pnlLayout(sales),
  totals: { tradingIncomeSen: sales, costOfSalesSen: 50_000, grossProfitSen: sales - 50_000, otherIncomeSen: 5_000, expensesSen: 10_500, profitBeforeTaxSen: sales - 55_500, taxationSen: 3_000, netProfitSen: sales - 58_500 },
});
const bsData = {
  assets: [{ code: '310-0010', name: 'BANK', amountSen: 93_000 }, { code: '330-0000', name: 'STOCK', amountSen: 10_000 }],
  liabilities: [{ code: '400-0000', name: 'AP', amountSen: 60_000 }, { code: '410-0010', name: 'ACCRUAL - SALARIES', amountSen: -2_000 }],
  equity: [],
  layout: {
    stored: true, baseSen: 103_000,
    assets: [{ kind: 'category' as const, id: 'sec:CURRENT ASSETS', label: 'CURRENT ASSETS', amountSen: 103_000, pct: 100, children: [acc('310-0010', 'BANK', 93_000, 90.3), acc('330-0000', 'STOCK', 10_000, 9.7)] }],
    liabilities: [{ kind: 'category' as const, id: 'sec:CURRENT LIABILITIES', label: 'CURRENT LIABILITIES', amountSen: 58_000, pct: 56.3, children: [acc('400-0000', 'AP', 60_000, 58.3), acc('410-0010', 'ACCRUAL - SALARIES', -2_000, -1.9)] }],
    equity: [],
  },
  totals: { assetsSen: 103_000, liabilitiesSen: 60_000, equitySen: 0, earningsSen: 43_000, checkSen: 0 },
};

/* Every column is one read: the P&L for its dates (September sold less), the balance sheet for its day. */
const reads = vi.hoisted(() => ({ keys: [] as unknown[][], fail: false }));
vi.mock('@tanstack/react-query', () => ({
  useQueries: ({ queries }: { queries: Array<{ queryKey: unknown[] }> }) => queries.map((q) => {
    reads.keys.push(q.queryKey);
    if (reads.fail) return { isLoading: false, isError: true, data: undefined };
    const [k, from] = q.queryKey as [string, string];
    return { isLoading: false, isError: false, data: k === 'report-pnl' ? pnl(String(from).startsWith('2026-09') ? 80_000 : 100_000) : bsData };
  }),
  useQuery: () => ({ isLoading: false, isError: false, data: undefined }),
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../vendor/scm/lib/ledger-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useLedger: () => ({ isLoading: false, isError: false, data: { blocks: [] } }),
}));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
/* A category's figure opens the General Ledger (docs/bugs/0924): the navigation is caught, not followed. */
const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useNavigate: () => navigateSpy }));
/* The editor has its own contract (ReportLayoutEditor.test.tsx); here it only has to open. */
vi.mock('./ReportLayoutEditor', () => ({ ReportLayoutEditor: () => <div role="dialog" aria-label="Layout · P&L">editor</div> }));

const xlsx = vi.fn(async (..._a: unknown[]) => {});
const pdf = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: (...a: unknown[]) => pdf(...a) }));

import { PnLTab, BalanceSheetTab } from './Reports';

const Where = () => {
  const l = useLocation();
  return <output aria-label="address">{`${l.pathname}${l.search}`}</output>;
};
const at = (url: string, ui: React.ReactNode) => render(
  <MemoryRouter initialEntries={[url]}><Routes><Route path="*" element={<>{ui}<Where /></>} /></Routes></MemoryRouter>,
);
const OCT = '/scm/accounting?tab=pnl&from=2026-10-01&to=2026-10-31';
type Sheet = { title: string; subtitle: string; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string; kind: string; depth: number; cells: unknown[] }> }> };

beforeEach(() => {
  reads.keys = [];
  reads.fail = false;
  navigateSpy.mockClear();
  xlsx.mockClear();
  pdf.mockClear();
  window.localStorage.removeItem('fin-reports-colw-v2');
});

describe('the P&L', () => {
  test('sections in order, gross and net where they belong, the closing stock note under cost of sales', () => {
    at(OCT, <PnLTab />);
    expect(screen.getByText('Trading income')).toBeTruthy();
    expect(screen.getByText('GROSS PROFIT').closest('tr')!.textContent).toContain('500.00');
    /* Tax posted → profit before tax, the Taxation section, then net AFTER tax. */
    expect(screen.getByText('PROFIT BEFORE TAX').closest('tr')!.textContent).toContain('445.00');
    expect(screen.getByText('Taxation')).toBeTruthy();
    const net = screen.getByText('NET PROFIT').closest('tr')!;
    expect(net.textContent).toContain('415.00');
    expect(net.className).toMatch(/rowFinal/);
    expect(screen.getByText(/Closing stock is what the shelves hold as of 2026\/10\/31/)).toBeTruthy();
    /* One read for the one column, on the period in the address. */
    expect(reads.keys).toContainEqual(['report-pnl', '2026-10-01', '2026-10-31']);
  });

  /* SIGNS (owner 2026-09-14, docs/bugs/0910): an expense is the positive
     figure it is; only a period whose credits beat its debits prints in
     parentheses — and never "(-1,139.19)". No RM prefix (owner 2026-09-19). */
  test('expenses print plain, a reversed line in parentheses with no minus inside them; the code before the name', () => {
    at(OCT, <PnLTab />);
    const advert = screen.getByText('ADVERT').closest('tr')!;
    expect(within(advert).getByText('900-A001')).toBeTruthy();
    expect(advert.textContent).toContain('120.00');
    expect(advert.textContent).not.toContain('(');
    expect(screen.getByText('ADVERT - SHOWROOM').closest('tr')!.textContent).toContain('(15.00)');
    expect(screen.getByText('STOCKS AT END').closest('tr')!.textContent).toContain('(100.00)');
    expect(screen.getByText('Total expenses').closest('tr')!.textContent).toContain('105.00');
    expect(document.body.textContent).not.toMatch(/\(-/);
    expect(document.body.textContent).not.toContain('RM ');
  });

  test('the tree: a category with its subtotal and %, every row with its % of sales beside; L1 / L2 / All fold it', () => {
    at(OCT, <PnLTab />);
    const op = screen.getByText('Operating Expense').closest('tr')!;
    expect(op.getAttribute('data-kind')).toBe('category');
    expect(op.textContent).toContain('105.00');
    expect(op.textContent).toContain('10.5%');
    expect(screen.getByText('ADVERT').closest('tr')!.textContent).toContain('12.0%');
    expect(screen.getByText('ADVERT - SHOWROOM').closest('tr')!.getAttribute('data-depth')).toBe('3');
    expect(screen.getByText('NET PROFIT').closest('tr')!.textContent).toContain('41.5%');
    const levels = screen.getByRole('group', { name: 'Levels' });
    fireEvent.click(within(levels).getByRole('button', { name: 'L1' }));
    expect(screen.queryByText('ADVERT')).toBeNull();
    expect(screen.getByText('Operating Expense').closest('tr')!.textContent).toContain('105.00');
    fireEvent.click(within(levels).getByRole('button', { name: 'L2' }));
    expect(screen.getByText('ADVERT')).toBeTruthy();
    expect(screen.queryByText('ADVERT - SHOWROOM')).toBeNull();
    fireEvent.click(within(levels).getByRole('button', { name: 'All' }));
    expect(screen.getByText('ADVERT - SHOWROOM')).toBeTruthy();
  });

  /* 点开看明细其实就是看 general ledger (owner 2026-09-14): an account's figure
     opens its lines under its row; a category's opens the ledger on every
     account beneath it, with Back to the report. */
  test('an account’s figure opens its lines under the row; a category’s opens the General ledger', () => {
    at(OCT, <PnLTab />);
    fireEvent.click(screen.getByRole('button', { name: /^501-0000 · SALES · / }));
    expect(screen.getByRole('region', { name: 'Lines of 501-0000 SALES' })).toBeTruthy();
    expect(navigateSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Operating Expense · / }));
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    const [href, opts] = navigateSpy.mock.calls[0]! as [string, { state: { back: { to: string; label: string } } }];
    expect(href).toBe('/scm/accounting?tab=gl&accounts=900-A001%2C900-A014&from=2026-10-01&to=2026-10-31&in=reports');
    expect(opts.state.back).toEqual({ to: OCT, label: 'P&L' });
  });

  test('% beside switches off: amounts alone on screen and in the export', async () => {
    at(OCT, <PnLTab />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Account', 'October 2026%']);
    fireEvent.click(screen.getByRole('switch', { name: '% beside' }));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Account', 'October 2026']);
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    expect((xlsx.mock.calls[0]![0] as Sheet).tables[0]!.columns.map((c) => c.label)).toEqual(['Amount']);
  });

  test('Compare: this period, the other and the change, each read once; against the same period last year', () => {
    at(OCT, <PnLTab />);
    fireEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'Compare' }));
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Account', 'October 2026This period%', 'September 2026Previous period%', 'ChangeThis period less the other']);
    expect(reads.keys).toContainEqual(['report-pnl', '2026-09-01', '2026-09-30']);
    /* Sales 1,000.00 against 800.00: the change is 200.00 on sales and on net. */
    const sales = screen.getByText('501-0000').closest('tr')!;
    expect([...sales.querySelectorAll('td')].at(-1)!.textContent).toBe('200.00');
    expect([...screen.getByText('NET PROFIT').closest('tr')!.querySelectorAll('td')].at(-1)!.textContent).toBe('200.00');
    fireEvent.click(within(screen.getByRole('group', { name: 'Compare against' })).getByRole('button', { name: 'Same period last year' }));
    expect(reads.keys).toContainEqual(['report-pnl', '2025-10-01', expect.stringMatching(/^2025-10-/)]);
  });

  test('By month: Total leftmost, then each month newest first — one read per column; Months picks how many', () => {
    at(OCT, <PnLTab />);
    fireEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'By month' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Months' })).getByRole('button', { name: '3' }));
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Account', 'Total3 months%', 'Oct 2026%', 'Sep 2026%', 'Aug 2026%']);
    expect(reads.keys).toContainEqual(['report-pnl', '2026-08-01', '2026-10-31']);
    expect(reads.keys).toContainEqual(['report-pnl', '2026-08-01', '2026-08-31']);
  });

  /* EXPORTS (owner 2026-09-19: 我这页显示什么就要 export 什么): Excel, PDF and
     Print carry the statement as shown — the lines at the level chosen. */
  test('Excel, PDF and Print carry the statement as shown — the lines at the level chosen', async () => {
    at(OCT, <PnLTab />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Levels' })).getByRole('button', { name: 'L1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [sheet, name] = xlsx.mock.calls[0]! as [Sheet, string];
    expect(name).toBe('pnl-2026-10-01-to-2026-10-31.xlsx');
    expect(sheet.title).toBe('P&L');
    expect(sheet.subtitle).toContain('level 1');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Amount', '% of sales']);
    const labels = sheet.tables[0]!.rows.map((r) => r.label);
    expect(labels).toContain('Operating Expense');
    expect(labels).not.toContain('900-A001 · ADVERT');
    expect(sheet.tables[0]!.rows.find((r) => r.label === 'NET PROFIT')).toMatchObject({ kind: 'net', cells: [41_500, 41.5] });
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(pdf).toHaveBeenCalledTimes(1));
    expect(pdf.mock.calls[0]![1]).toEqual({ fileName: 'pnl-2026-10-01-to-2026-10-31.pdf', action: 'preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    await waitFor(() => expect(pdf).toHaveBeenCalledTimes(2));
    expect(pdf.mock.calls[1]![1]).toEqual({ fileName: 'pnl-2026-10-01-to-2026-10-31.pdf', action: 'print' });
  });

  test('the Layout button opens the editor; a bad range asks for dates; a failed read says so', () => {
    at(OCT, <PnLTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · P&L' })).toBeTruthy();
    at('/scm/accounting?tab=pnl&from=2026-10-31&to=2026-10-01', <PnLTab />);
    expect(screen.getByText('Pick dates.')).toBeTruthy();
    reads.fail = true;
    at(OCT, <PnLTab />);
    expect(screen.getByRole('alert').textContent).toBe('The statement did not load — adjust the dates to retry.');
  });
});

describe('the balance sheet', () => {
  const BS = '/scm/accounting?tab=bs&from=2026-10-01&to=2026-10-31';

  test('tiles: total assets, liabilities, equity with the period’s earnings, and the check', () => {
    at(BS, <BalanceSheetTab />);
    const tiles = screen.getByRole('group', { name: 'Balance sheet figures' });
    expect(tiles.textContent).toContain('Total assets1,030.00');
    expect(tiles.textContent).toContain('Total liabilities600.00');
    expect(tiles.textContent).toContain('58.3% of total assets');
    expect(tiles.textContent).toContain('Equity430.00');
    expect(tiles.textContent).toContain('CheckBalanced');
    expect(reads.keys).toContainEqual(['report-bs', '2026-10-31']);
  });

  test('earnings inside equity, BALANCED as the final total, % of total assets on both sides', () => {
    at(BS, <BalanceSheetTab />);
    expect(screen.getByText('Current period earnings').closest('tr')!.textContent).toContain('430.00');
    const check = screen.getByText('BALANCED').closest('tr')!;
    expect(check.textContent).toContain('1,030.00');
    expect(check.className).toMatch(/rowFinal/);
    const totalAssets = screen.getAllByText('Total assets').map((el) => el.closest('tr')).find((tr) => tr !== null)!;
    expect(totalAssets.className).toMatch(/rowStrong/);
    expect(screen.getByText('STOCK').closest('tr')!.textContent).toContain('9.7%');
    expect(screen.getByText('AP').closest('tr')!.textContent).toContain('58.3%');
    expect(screen.getByText('ACCRUAL - SALARIES').closest('tr')!.textContent).toContain('(20.00)');
    expect(document.body.textContent).not.toMatch(/\(-/);
  });

  test('As at writes the day into the address; By month reads month-end balances and adds no Total', () => {
    at(BS, <BalanceSheetTab />);
    fireEvent.change(screen.getByLabelText('Balance sheet as at'), { target: { value: '2026/09/30' } });
    fireEvent.blur(screen.getByLabelText('Balance sheet as at'));
    expect(screen.getByLabelText('address').textContent).toContain('to=2026-09-30');
    fireEvent.click(within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'By month' }));
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads[1]).toBe('Sep 2026%');
    expect(heads).not.toContain('Total');
    expect(reads.keys).toContainEqual(['report-bs', '2026-08-31']);
  });

  test('Excel carries the statement as shown', async () => {
    at(BS, <BalanceSheetTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(xlsx).toHaveBeenCalledTimes(1));
    const [bs, bsName] = xlsx.mock.calls[0]! as [Sheet, string];
    expect(bs.title).toBe('Balance Sheet');
    expect(bsName).toBe('balance-sheet-2026-10-31.xlsx');
    expect(bs.tables[0]!.rows.find((r) => r.label === 'BALANCED')).toMatchObject({ kind: 'net', cells: [103_000, 100] });
  });
});
