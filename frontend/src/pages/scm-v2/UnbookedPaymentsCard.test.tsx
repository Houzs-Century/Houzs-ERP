/* The Self-check card for money that never reached the ledger (docs/bugs/0652).
   Pinned: a company where NOTHING has ever booked but payments exist reads red
   ("none, ever", with the money), not green; the Why? button asks the backfill
   endpoint in dry-run mode and prints each payment's verdict and reason. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { UnbookedPaymentsCard } from './Accounting';

const mockedFetch = vi.mocked(authedFetch);
const draw = (p: Parameters<typeof UnbookedPaymentsCard>[0]['p']) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <UnbookedPaymentsCard p={p} />
  </QueryClientProvider>,
);

describe('the never-booked state', () => {
  test('reads red with the money when nothing has ever booked but payments exist; Why? asks the dry run and prints verdicts', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValueOnce({
      ok: true, dryRun: true, scanned: 2, posted: 0, wouldPost: 1, skipped: 0, remaining: 1,
      failed: [{ id: 'p2', status: 'account_invalid', reason: 'account 999-0000 does not exist for company 2' }],
      rows: [
        { id: 'p1', docNo: '2990-SO-2606-001', paidOn: '2026-06-11', method: 'merchant', amountSen: 250000, status: 'would_post' },
        { id: 'p2', docNo: '2990-SO-2606-002', paidOn: '2026-06-12', method: 'transfer', amountSen: 100000, status: 'account_invalid', reason: 'account 999-0000 does not exist for company 2' },
      ],
    });
    draw({ since: null, rows: [], totalSen: 0, ok: true, neverBooked: { count: 171, totalSen: 40_359_350, firstPaidOn: '2026-06-11', lastPaidOn: '2026-09-06' } });
    expect(screen.getByText('none, ever')).toBeTruthy();
    expect(screen.getByText(/RM 403,593\.50 on 171 payments and not in the books/)).toBeTruthy();
    expect(screen.getByText(/171 were recorded between 2026-06-11 and 2026-09-06/)).toBeTruthy();

    fireEvent.click(screen.getByText('Why? (dry run)'));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/accounting/backfill/customer-payments', {
      method: 'POST', body: JSON.stringify({ dryRun: true, limit: 500 }),
    }));
    await waitFor(() => expect(screen.getByText(/2 unbooked payments put through the gate, nothing written/)).toBeTruthy());
    expect(screen.getByText('would post')).toBeTruthy();
    expect(screen.getByText('account_invalid')).toBeTruthy();
    expect(screen.getByText('account 999-0000 does not exist for company 2')).toBeTruthy();
  });

  test('a company with nothing booked AND nothing recorded stays green', () => {
    draw({ since: null, rows: [], totalSen: 0, ok: true, neverBooked: { count: 0, totalSen: 0, firstPaidOn: null, lastPaidOn: null } });
    expect(screen.getByText('all of them')).toBeTruthy();
    expect(screen.queryByText('Why? (dry run)')).toBeNull();
  });

  test('the after-boundary list still reads "N did not" and offers Why?', () => {
    draw({ since: '2026-08-01', ok: false, totalSen: 12345, rows: [
      { source: 'SOPAY', id: 'p3', docNo: 'SO-3', paidOn: '2026-08-05', amountSen: 12345, method: 'cash' },
    ] });
    expect(screen.getByText('1 did not')).toBeTruthy();
    expect(screen.getByText('Why? (dry run)')).toBeTruthy();
  });
});
