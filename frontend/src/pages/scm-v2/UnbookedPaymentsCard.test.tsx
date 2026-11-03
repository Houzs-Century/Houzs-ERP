/* Self-check's row for money that never reached the ledger (docs/bugs/0652),
   in the owner's redesign (batch 6 §3). Pinned: a company where NOTHING has
   ever booked but payments exist reads red ("none, ever", with the money),
   not clean; the Why? button asks the backfill endpoint in dry-run mode and
   prints each payment's verdict and reason; Book N payments appears only
   after a dry run the gate refused nothing on, behind an inline confirm, and
   runs the real backfill. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { UnbookedRowCheck } from './SelfCheck';

const mockedFetch = vi.mocked(authedFetch);
const onToast = vi.fn();
const draw = (p: Parameters<typeof UnbookedRowCheck>[0]['p']) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter><UnbookedRowCheck p={p} onToast={onToast} /></MemoryRouter>
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
    expect(screen.getByText('RM 403,593.50')).toBeTruthy();
    expect(screen.getByText('171 payments were recorded and none ever reached the books')).toBeTruthy();
    expect(screen.getByText(/171 were recorded between 2026\/06\/11 and 2026\/09\/06/)).toBeTruthy();

    fireEvent.click(screen.getByText('Why? (dry run)'));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/accounting/backfill/customer-payments', {
      method: 'POST', body: JSON.stringify({ dryRun: true, limit: 500 }),
    }));
    await waitFor(() => expect(screen.getByText(/Dry run: 2 unbooked payments put through the gate, nothing written/)).toBeTruthy());
    expect(screen.getAllByText('would post').length).toBeGreaterThan(0);
    expect(screen.getAllByText('account_invalid').length).toBeGreaterThan(0);
    expect(screen.getByText('account 999-0000 does not exist for company 2')).toBeTruthy();
    /* A refusal: no Book button. */
    expect(screen.queryByText(/^Book \d/)).toBeNull();
  });

  test('a company with nothing booked AND nothing recorded reads clean and offers no dry run', () => {
    draw({ since: null, rows: [], totalSen: 0, ok: true, neverBooked: { count: 0, totalSen: 0, firstPaidOn: null, lastPaidOn: null } });
    expect(screen.getByText('Clean')).toBeTruthy();
    expect(screen.queryByText('Why? (dry run)')).toBeNull();
  });

  test('the after-boundary list reads "N not in the books", counts from the first booked day, and offers Why?', () => {
    draw({ since: '2026-08-01', ok: false, totalSen: 12345, rows: [
      { source: 'SOPAY', id: 'p3', docNo: 'SO-3', paidOn: '2026-08-05', amountSen: 12345, method: 'cash' },
    ] });
    expect(screen.getByText('1 not in the books')).toBeTruthy();
    expect(screen.getByText('1 payment since 2026/08/01 did not')).toBeTruthy();
    expect(screen.getByText(/Counting from 2026\/08\/01, the first day this company booked a payment/)).toBeTruthy();
    expect(screen.getByText('Why? (dry run)')).toBeTruthy();
  });

  test('a check that could not run says so instead of reading clean', () => {
    draw({ since: null, rows: [], totalSen: 0, ok: false, error: 'payments: timeout' });
    expect(screen.getByText('Not checked')).toBeTruthy();
    expect(screen.getByText(/The check could not run: payments: timeout/)).toBeTruthy();
  });
});

describe('Book N payments (docs/bugs/0655)', () => {
  test('appears only after a dry run the gate refused nothing on, confirms inline, then runs the real backfill', async () => {
    mockedFetch.mockReset(); onToast.mockClear();
    const clean = {
      ok: true, dryRun: true, scanned: 2, posted: 0, wouldPost: 2, skipped: 0, remaining: 0, failed: [],
      rows: [
        { id: 'p1', docNo: '2990-SO-2606-001', paidOn: '2026-06-11', method: 'transfer', amountSen: 12500, status: 'would_post' },
        { id: 'p2', docNo: '2990-SO-2606-002', paidOn: '2026-06-12', method: 'merchant', amountSen: 193300, status: 'would_post' },
      ],
    };
    mockedFetch.mockResolvedValueOnce(clean);
    mockedFetch.mockResolvedValueOnce({ ...clean, dryRun: false, posted: 2, wouldPost: 0 });
    draw({ since: null, rows: [], totalSen: 0, ok: false, neverBooked: { count: 2, totalSen: 205800, firstPaidOn: '2026-06-11', lastPaidOn: '2026-06-12' } });
    expect(screen.queryByText('Book 2 payments')).toBeNull();
    fireEvent.click(screen.getByText('Why? (dry run)'));
    await waitFor(() => expect(screen.getByText('Book 2 payments')).toBeTruthy());
    fireEvent.click(screen.getByText('Book 2 payments'));
    /* The inline confirm says what posts, and nothing is written until it is pressed. */
    expect(screen.getByText('Book 2 payments into the ledger?')).toBeTruthy();
    expect(screen.getByText(/Each posts on its own paid date, RM 2,058\.00 in total: Dr bank or cash, Cr Trade debtors\./)).toBeTruthy();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Book them'));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/accounting/backfill/customer-payments', {
      method: 'POST', body: JSON.stringify({ limit: 500 }),
    }));
    await waitFor(() => expect(screen.getByText(/Booked 2, skipped 0, refused 0/)).toBeTruthy());
    expect(screen.getByText(/Every payment is in the books now/)).toBeTruthy();
    expect(onToast).toHaveBeenCalledWith('Booked 2 payments · RM 2,058.00');
  });

  test('Cancel on the confirm writes nothing', async () => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValueOnce({
      ok: true, dryRun: true, scanned: 1, posted: 0, wouldPost: 1, skipped: 0, remaining: 0, failed: [],
      rows: [{ id: 'p1', docNo: '2990-SO-2606-001', paidOn: '2026-06-11', method: 'transfer', amountSen: 12500, status: 'would_post' }],
    });
    draw({ since: '2026-06-01', rows: [{ source: 'SOPAY', id: 'p1', docNo: '2990-SO-2606-001', paidOn: '2026-06-11', amountSen: 12500, method: 'transfer' }], totalSen: 12500, ok: false });
    fireEvent.click(screen.getByText('Why? (dry run)'));
    await waitFor(() => expect(screen.getByText('Book 1 payment')).toBeTruthy());
    fireEvent.click(screen.getByText('Book 1 payment'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Book them')).toBeNull();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
