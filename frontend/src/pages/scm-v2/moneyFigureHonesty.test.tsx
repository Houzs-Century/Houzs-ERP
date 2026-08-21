// A money figure the app could not read must never render as a money figure.
//
// WHY THIS FILE EXISTS. Two screens folded a total over a list that was empty
// BECAUSE THE READ FAILED, and printed the result as a fact:
//
//   * Trial Balance (`Accounting.tsx`) — `q.data?.balances ?? []` gives `[]`,
//     so `dr - cr === 0`, so the difference tile renders in the GREEN frame
//     reading "RM 0.00 — books balance". An accountant closing the month signs
//     off on a general ledger that was never actually read.
//   * Inventory > COGS (`Inventory.tsx`) — `data ?? []` gives `[]`, so
//     `totalCogs === 0`, so the card reads "Total COGS RM 0.00" and the table
//     says "No COGS entries yet". The comment above that card already knew the
//     hazard and wired `pending={isLoading}` only — and `isLoading` is FALSE
//     after a failed fetch.
//
// `StatCard`'s own doc comment states the rule these two broke: "A figure the
// app cannot vouch for must never be rendered as a figure — least of all a
// money one."
//
// These tests assert the CONTRACT: on a failed read the screen does not print a
// number, and it says the read failed. They fail on the pre-fix tree.
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

import { TrialBalanceTab } from './Accounting';
import { CogsTab } from './Inventory';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>
);

/** What a failed TanStack read actually looks like: not loading, no data. */
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

    // The claim that must NOT be on screen.
    expect(screen.queryByText(/books balance/i)).toBeNull();
    // And the operator must be told why the report is blank.
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

    // "Total COGS RM 0.00" is the lie. Any RM figure at all is.
    expect(screen.queryByText(/RM\s*0\.00/)).toBeNull();
    // And "0 consumption entries" / "No COGS entries yet" must not stand alone.
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
