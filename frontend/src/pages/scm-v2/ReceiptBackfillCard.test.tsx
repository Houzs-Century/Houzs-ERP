// The receipts card on Self-check: the count, the numbers per month, the run
// behind a confirmation, the result; a failed read says so.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { authedFetch, confirmSpy } = vi.hoisted(() => ({ authedFetch: vi.fn(), confirmSpy: vi.fn() }));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch }));
vi.mock('../../vendor/scm/components/ConfirmDialog', () => ({ useConfirm: () => confirmSpy }));

import { ReceiptBackfillCard, monthWord, seriesLine } from './ReceiptBackfillCard';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>
);

const PLAN = {
  total: 43,
  months: [
    { ym: '2606', payments: 43, cash: 3, confirmedCards: 33, unlettered: 0, series: [
      { series: '2990-DraftOR-2606', count: 43, from: '2990-DraftOR-2606-001', to: '2990-DraftOR-2606-043' },
      { series: '2990-COR-2606', count: 3, from: '2990-COR-2606-001', to: '2990-COR-2606-003' },
      { series: '2990-HOR-2606', count: 21, from: '2990-HOR-2606-001', to: '2990-HOR-2606-021' },
      { series: '2990-MOR-2606', count: 12, from: '2990-MOR-2606-001', to: '2990-MOR-2606-012' },
    ] },
  ],
};

beforeEach(() => { authedFetch.mockReset(); confirmSpy.mockReset(); });
afterEach(cleanup);

describe('ReceiptBackfillCard', () => {
  it('words', () => {
    expect(monthWord('2606')).toBe('06/2026');
    expect(seriesLine(PLAN.months[0]!.series[0]!)).toBe('2990-DraftOR-2606-001 – 043 (43)');
    expect(seriesLine({ series: 'x', count: 1, from: '2990-COR-2609-001', to: '2990-COR-2609-001' })).toBe('2990-COR-2609-001 (1)');
  });

  it('shows the count and the numbers per month, runs only after the confirmation, and reports the result', async () => {
    /* Batched (owner 2026-09-16): two calls, the second says nothing is left. */
    let posts = 0;
    authedFetch.mockImplementation((path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') { posts += 1; return Promise.resolve(posts === 1 ? { created: 30, formalised: 20, failed: [], remaining: 13 } : { created: 13, formalised: 13, failed: [], remaining: 0 }); }
      return Promise.resolve(PLAN);
    });
    confirmSpy.mockResolvedValue(true);
    render(wrap(<ReceiptBackfillCard />));
    await waitFor(() => expect(screen.getByText('43 payments without one')).toBeTruthy());
    expect(screen.getByText('06/2026')).toBeTruthy();
    expect(screen.getByText('2990-DraftOR-2606-001 – 043 (43)')).toBeTruthy();
    expect(screen.getByText('2990-HOR-2606-001 – 021 (21)')).toBeTruthy();
    expect(screen.getByText(/3 cash · 33 card confirmed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create 43 receipts now' }));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/accounting/receipts/backfill', { method: 'POST' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'Create 43 receipts now?' }));
    await waitFor(() => expect(screen.getByText(/Created 43, formal 33, refused 0/)).toBeTruthy());
    expect(screen.getByText(/every payment has one now/)).toBeTruthy();
    expect(posts).toBe(2);
  });

  it('a declined confirmation runs nothing; a clean company says so; a failed read says so', async () => {
    authedFetch.mockResolvedValue(PLAN);
    confirmSpy.mockResolvedValue(false);
    render(wrap(<ReceiptBackfillCard />));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create 43 receipts now' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Create 43 receipts now' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(authedFetch).not.toHaveBeenCalledWith('/accounting/receipts/backfill', { method: 'POST' });
    cleanup();
    authedFetch.mockResolvedValue({ total: 0, months: [] });
    render(wrap(<ReceiptBackfillCard />));
    await waitFor(() => expect(screen.getByText('every payment has one')).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    /* A 403 is a decision, not a blip: no retry, so the card answers at once. */
    authedFetch.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    render(wrap(<ReceiptBackfillCard />));
    await waitFor(() => expect(screen.getByText(/not checked — the read failed/)).toBeTruthy());
  });
});
