import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { useAccountBalances } = vi.hoisted(() => ({ useAccountBalances: vi.fn() }));
const { useCogsEntries } = vi.hoisted(() => ({ useCogsEntries: vi.fn() }));

vi.mock('../../vendor/scm/lib/accounting-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useAccountBalances,
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useCogsEntries,
}));

import { TrialBalanceTab } from './TrialBalance';
import { CogsTab } from './Inventory';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const failedRead = (error: Error) => ({
  data: undefined,
  isLoading: false,
  isPending: false,
  isError: true,
  isSuccess: false,
  error,
  status: 'error' as const,
});

afterEach(cleanup);
beforeEach(() => { useAccountBalances.mockReset(); useCogsEntries.mockReset(); });

describe('Trial Balance', () => {
  it('does not say "books balance" off a ledger it failed to read', () => {
    useAccountBalances.mockReturnValue(failedRead(new Error('account balances are unavailable')));
    render(wrap(<TrialBalanceTab />));

    expect(screen.queryByText(/books balance/i)).toBeNull();
    expect(screen.getAllByText(/account balances are unavailable|couldn't|could not|failed/i).length).toBeGreaterThan(0);
  });

  it('still self-checks the books when the read SUCCEEDS', () => {
    useAccountBalances.mockReturnValue({
      data: { balances: [
        { account_code: '300-0000', account_name: 'AR', account_type: 'ASSET', total_debit_sen: 5000, total_credit_sen: 5000, balance_sen: 0 },
      ] },
      isLoading: false, isPending: false, isError: false, isSuccess: true, error: null, status: 'success' as const,
    });
    render(wrap(<TrialBalanceTab />));
    expect(screen.getByText(/books balance/i)).toBeTruthy();
  });
});

describe('Inventory > COGS', () => {
  it('does not print RM 0.00 for a cost of goods it failed to read', () => {
    useCogsEntries.mockReturnValue(failedRead(new Error('COGS entries are unavailable')));
    render(wrap(<CogsTab warehouseId={null} search="" />));

    expect(screen.queryByText(/RM\s*0\.00/)).toBeNull();
    expect(screen.getAllByText(/COGS entries are unavailable|couldn't|could not|failed/i).length).toBeGreaterThan(0);
  });

  it('still totals the cost when the read SUCCEEDS', () => {
    useCogsEntries.mockReturnValue({
      data: [
        { id: 'c1', consumed_at: '2026-08-20T00:00:00.000Z', warehouse_code: 'KL', item_code: 'X', qty: 1, total_cost_sen: 12345 },
      ],
      isLoading: false, isPending: false, isError: false, isSuccess: true, error: null, status: 'success' as const,
    });
    render(wrap(<CogsTab warehouseId={null} search="" />));
    expect(screen.getAllByText(/RM\s*123\.45/).length).toBeGreaterThan(0);
  });
});
