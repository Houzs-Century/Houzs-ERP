// The standard statements' screen (GL redesign item 6): the P&L renders the
// owner's sections with gross and net where they belong, and the balance
// sheet says BALANCED only when the self-check is zero.

import { describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
  totals: { tradingIncomeSen: 100_000, costOfSalesSen: 50_000, grossProfitSen: 50_000, otherIncomeSen: 5_000, expensesSen: 10_500, profitBeforeTaxSen: 44_500, taxationSen: 3_000, netProfitSen: 41_500 },
};
const bsData = {
  assets: [{ code: '310-0010', name: 'BANK', amountSen: 93_000 }, { code: '330-0000', name: 'STOCK', amountSen: 10_000 }],
  liabilities: [{ code: '400-0000', name: 'AP', amountSen: 60_000 }, { code: '410-0010', name: 'ACCRUAL - SALARIES', amountSen: -2_000 }],
  equity: [],
  totals: { assetsSen: 103_000, liabilitiesSen: 60_000, equitySen: 0, earningsSen: 43_000, checkSen: 0 },
};

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: { queryKey: string[] }) => ({
    isLoading: false, isError: false,
    data: String(opts.queryKey[0]).includes('pnl') ? pnlData : bsData,
  }),
}));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));

import { PnLTab, BalanceSheetTab } from './Reports';

describe('the standard statements', () => {
  test('P&L: sections in order, gross and net where they belong', () => {
    render(<PnLTab />);
    expect(screen.getByText('Trading income')).toBeTruthy();
    expect(screen.getByText(/Cost of sales/)).toBeTruthy();
    const gross = screen.getByText('GROSS PROFIT').closest('tr')!;
    expect(gross.textContent).toContain('RM 500.00');
    /* Tax posted → profit before tax, the Taxation section, then net AFTER tax. */
    expect(screen.getByText('PROFIT BEFORE TAX').closest('tr')!.textContent).toContain('RM 445.00');
    expect(screen.getByText('Taxation')).toBeTruthy();
    const net = screen.getByText('NET PROFIT').closest('tr')!;
    expect(net.textContent).toContain('RM 415.00');
    expect(screen.getByText(/620-0000/)).toBeTruthy();
  });

  /* SIGNS (owner 2026-09-14, docs/bugs/0910): an expense is the positive
     figure it is; only a period whose credits beat its debits prints in
     parentheses — and never "(RM -1,139.19)", a minus inside the brackets. */
  test('P&L: expenses print plain, a reversed line in parentheses with no minus inside them', () => {
    render(<PnLTab />);
    expect(screen.getByText(/900-A001/).closest('tr')!.textContent).toContain('RM 120.00');
    expect(screen.getByText(/900-A001/).closest('tr')!.textContent).not.toContain('(');
    expect(screen.getByText(/900-A014/).closest('tr')!.textContent).toContain('(RM 15.00)');
    /* The closing-stock credit inside cost of sales is a credit too. */
    expect(screen.getByText(/620-0000/).closest('tr')!.textContent).toContain('(RM 100.00)');
    expect(screen.getByText(/601-0003/).closest('tr')!.textContent).toContain('RM 600.00');
    expect(screen.getByText('Total expenses').closest('tr')!.textContent).toContain('RM 105.00');
    expect(document.body.textContent).not.toMatch(/\(RM -/);
  });

  test('Balance sheet: earnings inside equity and BALANCED at zero check', () => {
    render(<BalanceSheetTab />);
    expect(screen.getByText('Current period earnings').closest('tr')!.textContent).toContain('RM 430.00');
    const check = screen.getByText('BALANCED').closest('tr')!;
    expect(check.textContent).toContain('RM 1,030.00');
    /* A credit-side balance on the wrong side prints in parentheses, not "RM -". */
    expect(screen.getByText(/410-0010/).closest('tr')!.textContent).toContain('(RM 20.00)');
    expect(document.body.textContent).not.toMatch(/RM -/);
  });
});
