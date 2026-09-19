// The standard statements' screen (GL redesign item 6): the P&L renders the
// owner's sections with gross and net where they belong, and the balance
// sheet says BALANCED only when the self-check is zero. Since docs/bugs/0911
// the P&L draws each block on the report's LAYOUT — category subtotals, % of
// sales on every row, L1..Ln buttons — and offers the layout editor.

import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const acc = (code: string, name: string, amountSen: number, pct: number | null) =>
  ({ kind: 'account' as const, id: `acc:${code}`, label: `${code} — ${name}`, code, amountSen, pct, children: [] });
const pnlLayout = {
  stored: false,
  baseSen: 100_000,
  tradingIncome: [{ kind: 'category' as const, id: 'sec:SALES', label: 'SALES', amountSen: 100_000, pct: 100, children: [acc('501-0000', 'SALES', 100_000, 100)] }],
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
};

const pnlData = {
  tradingIncome: [{ code: '501-0000', name: 'SALES', amountSen: 100_000 }],
  costOfSales: [
    { code: '601-0003', name: 'PURCHASE OF SOFA', amountSen: 60_000 },
    { code: '620-0000', name: 'STOCKS AT END', amountSen: -10_000 },
  ],
  otherIncome: [{ code: '590-0000', name: 'RENT RECEIVED', amountSen: 5_000 }],
  expenses: [
    { code: '900-A001', name: 'ADVERT', amountSen: 12_000 },
    { code: '900-A014', name: 'ADVERT - SHOWROOM', amountSen: -1_500 },   // reversed this period: credits beat debits
  ],
  taxation: [{ code: '950-0000', name: 'TAXATION', amountSen: 3_000 }],
  layout: pnlLayout,
  totals: { tradingIncomeSen: 100_000, costOfSalesSen: 50_000, grossProfitSen: 50_000, otherIncomeSen: 5_000, expensesSen: 10_500, profitBeforeTaxSen: 44_500, taxationSen: 3_000, netProfitSen: 41_500 },
};
const bsData = {
  assets: [{ code: '310-0010', name: 'BANK', amountSen: 93_000 }, { code: '330-0000', name: 'STOCK', amountSen: 10_000 }],
  liabilities: [{ code: '400-0000', name: 'AP', amountSen: 60_000 }, { code: '410-0010', name: 'ACCRUAL - SALARIES', amountSen: -2_000 }],
  equity: [],
  layout: {
    stored: false, baseSen: 103_000,
    assets: [{ kind: 'category' as const, id: 'sec:CURRENT ASSETS', label: 'CURRENT ASSETS', amountSen: 103_000, pct: 100, children: [acc('310-0010', 'BANK', 93_000, 90.3), acc('330-0000', 'STOCK', 10_000, 9.7)] }],
    liabilities: [{ kind: 'category' as const, id: 'sec:CURRENT LIABILITIES', label: 'CURRENT LIABILITIES', amountSen: 58_000, pct: 56.3, children: [acc('400-0000', 'AP', 60_000, 58.3), acc('410-0010', 'ACCRUAL - SALARIES', -2_000, -1.9)] }],
    equity: [],
  },
  totals: { assetsSen: 103_000, liabilitiesSen: 60_000, equitySen: 0, earningsSen: 43_000, checkSen: 0 },
};

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: string[] }) => ({
    isLoading: false, isError: false,
    data: String(opts.queryKey[0]).includes('pnl') ? pnlData : bsData,
  }),
  useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
/* A figure opens the General Ledger (docs/bugs/0924): the navigation is caught, not followed. */
const { navigateSpy } = vi.hoisted(() => ({ navigateSpy: vi.fn() }));
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useNavigate: () => navigateSpy }));
/* The editor has its own contract (ReportLayoutEditor.test.tsx); here it only has to open. */
vi.mock('./ReportLayoutEditor', () => ({ ReportLayoutEditor: () => <div role="dialog" aria-label="Layout · P&L">editor</div> }));
/* The monthly view has its own contract (MonthlyReport.test.tsx); here it only has to be reached. */
vi.mock('./MonthlyReport', () => ({
  MonthlyReport: (p: { title: string; withCumulative: boolean }) => <div role="region" aria-label={`Monthly · ${p.title}`}>{p.withCumulative ? 'with 累计' : 'no 累计'}</div>,
  ByMonthButton: ({ on, onToggle }: { on: boolean; onToggle: () => void }) => <button type="button" aria-pressed={on} onClick={onToggle}>By month</button>,
}));

const xlsx = vi.fn(async (..._a: unknown[]) => {});
const pdf = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../../vendor/scm/lib/report-sheet-xlsx', () => ({ downloadReportXlsx: (...a: unknown[]) => xlsx(...a) }));
vi.mock('../../vendor/scm/lib/report-sheet-pdf', () => ({ generateReportPdf: (...a: unknown[]) => pdf(...a) }));

import { PnLTab, BalanceSheetTab } from './Reports';

describe('the standard statements', () => {
  test('P&L: sections in order, gross and net where they belong', () => {
    render(<PnLTab />);
    expect(screen.getByText('Trading income')).toBeTruthy();
    expect(screen.getByText(/Cost of sales/)).toBeTruthy();
    const gross = screen.getByText('GROSS PROFIT').closest('tr')!;
    expect(gross.textContent).toContain('500.00');
    /* Tax posted → profit before tax, the Taxation section, then net AFTER tax. */
    expect(screen.getByText('PROFIT BEFORE TAX').closest('tr')!.textContent).toContain('445.00');
    expect(screen.getByText('Taxation')).toBeTruthy();
    const net = screen.getByText('NET PROFIT').closest('tr')!;
    expect(net.textContent).toContain('415.00');
    expect(screen.getByText(/620-0000/)).toBeTruthy();
  });

  /* SIGNS (owner 2026-09-14, docs/bugs/0910): an expense is the positive
     figure it is; only a period whose credits beat its debits prints in
     parentheses — and never "(-1,139.19)", a minus inside the brackets. No RM
     prefix, as the Cash Flow reads (owner 2026-09-19). */
  test('P&L: expenses print plain, a reversed line in parentheses with no minus inside them', () => {
    render(<PnLTab />);
    expect(screen.getByText(/900-A001/).closest('tr')!.textContent).toContain('120.00');
    expect(screen.getByText(/900-A001/).closest('tr')!.textContent).not.toContain('(');
    expect(screen.getByText(/900-A014/).closest('tr')!.textContent).toContain('(15.00)');
    /* The closing-stock credit inside cost of sales is a credit too. */
    expect(screen.getByText(/620-0000/).closest('tr')!.textContent).toContain('(100.00)');
    expect(screen.getByText(/601-0003/).closest('tr')!.textContent).toContain('600.00');
    expect(screen.getByText('Total expenses').closest('tr')!.textContent).toContain('105.00');
    expect(document.body.textContent).not.toMatch(/\(-/);
  });

  /* LAYOUT (owner 2026-09-14, docs/bugs/0911): category subtotals, % of
     sales on every row, the tree opened to a level. */
  test('P&L: the tree — a category with its subtotal and %, every row with its % of sales, totals too', () => {
    render(<PnLTab />);
    expect(screen.getByText('% of sales')).toBeTruthy();
    const op = screen.getByText('Operating Expense').closest('tr')!;
    expect(op.getAttribute('data-kind')).toBe('category');
    expect(op.textContent).toContain('105.00');
    expect(op.textContent).toContain('10.5%');
    expect(screen.getByText(/900-A001/).closest('tr')!.textContent).toContain('12.0%');
    expect(screen.getByText(/900-A014/).closest('tr')!.textContent).toContain('-1.5%');
    expect(screen.getByText(/900-A014/).closest('tr')!.getAttribute('data-depth')).toBe('3');
    expect(screen.getByText('GROSS PROFIT').closest('tr')!.textContent).toContain('50.0%');
    expect(screen.getByText('NET PROFIT').closest('tr')!.textContent).toContain('41.5%');
    expect(screen.getByText('Total expenses').closest('tr')!.textContent).toContain('10.5%');
  });

  /* 点开看明细其实就是看 general ledger (owner 2026-09-14; docs/bugs/0924): a
     figure opens the ledger on the row's accounts for the period — an account
     on its own, a category on every account beneath it. */
  test('P&L: a figure opens the General Ledger on its accounts and the period', () => {
    navigateSpy.mockClear();
    render(<PnLTab />);
    fireEvent.click(screen.getByRole('button', { name: '501-0000 — SALES total' }));
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(String(navigateSpy.mock.calls[0]![0])).toMatch(/^\/scm\/accounting\?tab=gl&accounts=501-0000&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
    fireEvent.click(screen.getByRole('button', { name: 'Operating Expense total' }));
    expect(String(navigateSpy.mock.calls[1]![0])).toContain('accounts=900-A001%2C900-A014');
  });

  test('P&L: L1 folds the tree to its categories, All opens every account; the Layout button opens the editor', () => {
    render(<PnLTab />);
    const levels = screen.getByRole('group', { name: 'Levels' });
    expect(levels.textContent).toContain('L3');
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    expect(screen.queryByText(/900-A001/)).toBeNull();
    expect(screen.queryByText('ADVERTISEMENT')).toBeNull();
    /* The subtotal stands while the rows are folded. */
    expect(screen.getByText('Operating Expense').closest('tr')!.textContent).toContain('105.00');
    fireEvent.click(screen.getByRole('button', { name: 'L2' }));
    expect(screen.getByText(/900-A001/)).toBeTruthy();
    expect(screen.queryByText(/900-A014/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText(/900-A014/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · P&L' })).toBeTruthy();
  });

  /* BY MONTH (docs/bugs/0916): the switch swaps the period for the monthly
     view — the P&L with a 累计 column, the balance sheet without one. */
  test('By month: the P&L opens the monthly view with 累计; the balance sheet without; the period controls step aside', () => {
    render(<PnLTab />);
    expect(screen.queryByRole('region')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    expect(screen.getByRole('region', { name: 'Monthly · P&L' }).textContent).toBe('with 累计');
    expect(screen.queryByLabelText('P&L from')).toBeNull();
    expect(screen.queryByText('GROSS PROFIT')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByLabelText('P&L from')).toBeTruthy();
    expect(screen.getByText('GROSS PROFIT')).toBeTruthy();
  });

  test('Balance sheet: By month has no 累计 column', () => {
    render(<BalanceSheetTab />);
    fireEvent.click(screen.getByRole('button', { name: 'By month' }));
    expect(screen.getByRole('region', { name: 'Monthly · Balance Sheet (as at month end)' }).textContent).toBe('no 累计');
    expect(screen.queryByText('BALANCED')).toBeNull();
  });

  test('Balance sheet: earnings inside equity and BALANCED at zero check', () => {
    render(<BalanceSheetTab />);
    expect(screen.getByText('Current period earnings').closest('tr')!.textContent).toContain('430.00');
    const check = screen.getByText('BALANCED').closest('tr')!;
    expect(check.textContent).toContain('1,030.00');
    /* A credit-side balance on the wrong side prints in parentheses, never a minus. */
    expect(screen.getByText(/410-0010/).closest('tr')!.textContent).toContain('(20.00)');
    expect(document.body.textContent).not.toMatch(/\(-/);
    expect(document.body.textContent).not.toContain('RM ');
  });

  /* LAYOUT (docs/bugs/0912): the balance sheet on its tree, every line's %
     of TOTAL ASSETS — on the liability side too. */
  test('Balance sheet: the tree with % of total assets on both sides, L1 folds it, the Layout button opens the editor', () => {
    render(<BalanceSheetTab />);
    expect(screen.getByText('% of total assets')).toBeTruthy();
    const assets = screen.getByText('CURRENT ASSETS').closest('tr')!;
    expect(assets.getAttribute('data-kind')).toBe('category');
    expect(assets.textContent).toContain('1,030.00');
    expect(assets.textContent).toContain('100.0%');
    expect(screen.getByText(/330-0000/).closest('tr')!.textContent).toContain('9.7%');
    /* A liability's % is of total assets. */
    expect(screen.getByText(/400-0000/).closest('tr')!.textContent).toContain('58.3%');
    expect(screen.getByText('Total liabilities').closest('tr')!.textContent).toContain('58.3%');
    expect(screen.getByText('Current period earnings').closest('tr')!.textContent).toContain('41.7%');
    expect(screen.getByText('BALANCED').closest('tr')!.textContent).toContain('100.0%');
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    expect(screen.queryByText(/330-0000/)).toBeNull();
    expect(screen.getByText('CURRENT ASSETS').closest('tr')!.textContent).toContain('1,030.00');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText(/330-0000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Layout' }));
    expect(screen.getByRole('dialog', { name: 'Layout · P&L' })).toBeTruthy();
  });

  /* EXPORTS (owner 2026-09-19: 我这页显示什么就要 export 什么): Excel and PDF carry
     the statement as shown — the lines at the level chosen, no RM. */
  test('Excel and PDF carry the statement as shown — the lines at the level chosen', () => {
    type Sheet = { title: string; subtitle: string; tables: Array<{ columns: Array<{ label: string }>; rows: Array<{ label: string; kind: string; depth: number; cells: unknown[] }> }> };
    render(<PnLTab />);
    fireEvent.click(screen.getByRole('button', { name: 'L1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }));
    expect(xlsx).toHaveBeenCalledTimes(1);
    const [sheet, name] = xlsx.mock.calls[0]! as [Sheet, string];
    expect(name).toMatch(/^pnl-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(sheet.title).toBe('P&L');
    expect(sheet.subtitle).toContain('level 1');
    expect(sheet.tables[0]!.columns.map((c) => c.label)).toEqual(['Amount', '% of sales']);
    const labels = sheet.tables[0]!.rows.map((r) => r.label);
    expect(labels).toContain('Operating Expense');
    /* Folded away at L1, as on the screen. */
    expect(labels).not.toContain('900-A001 — ADVERT');
    expect(sheet.tables[0]!.rows.find((r) => r.label === 'NET PROFIT')).toMatchObject({ kind: 'net', cells: [41_500, 41.5] });
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    expect(pdf).toHaveBeenCalledTimes(1);
    expect((pdf.mock.calls[0]![1] as { fileName: string }).fileName).toMatch(/^pnl-.*\.pdf$/);
    xlsx.mockClear();
    render(<BalanceSheetTab />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Excel' })[1]!);
    const [bs, bsName] = xlsx.mock.calls[0]! as [Sheet, string];
    expect(bs.title).toBe('Balance Sheet');
    expect(bsName).toMatch(/^balance-sheet-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(bs.tables[0]!.rows.find((r) => r.label === 'BALANCED')).toMatchObject({ kind: 'net', cells: [103_000, 100] });
  });

});
