// Self-check's "Official receipts" row (batch 6 §3; once ReceiptBackfillCard):
// the count, the numbers per month, the run behind an inline confirm, the run
// in batches, the result; a failed read says so.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authedFetch } = vi.hoisted(() => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch }));

import { monthLabel, monthsWord, seriesLine, useReceiptBackfillPlan } from './receipt-backfill-queries';
import { ReceiptsRowCheck } from './SelfCheck';

const onToast = vi.fn();
function Row() {
  const q = useReceiptBackfillPlan();
  return <ReceiptsRowCheck q={q} onToast={onToast} />;
}
const draw = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <MemoryRouter><Row /></MemoryRouter>
  </QueryClientProvider>,
);

const PLAN = {
  total: 43,
  months: [
    { ym: '2606', payments: 43, cash: 3, confirmedCards: 33, unlettered: 0, series: [
      { series: '2990-DraftOR-2606', count: 43, from: '2990-DraftOR-2606-001', to: '2990-DraftOR-2606-043' },
      { series: '2990-HOR-2606', count: 21, from: '2990-HOR-2606-001', to: '2990-HOR-2606-021' },
    ] },
  ],
};

beforeEach(() => { authedFetch.mockReset(); onToast.mockClear(); });
afterEach(cleanup);

describe('the words', () => {
  it('names a month, the months of a plan, and the numbers a series takes', () => {
    expect(monthLabel('2606')).toBe('June 2026');
    expect(monthsWord(PLAN.months)).toBe('June 2026');
    expect(monthsWord([...PLAN.months, { ...PLAN.months[0]!, ym: '2607' }])).toBe('June 2026 and July 2026');
    expect(monthsWord([...PLAN.months, { ...PLAN.months[0]!, ym: '2607' }, { ...PLAN.months[0]!, ym: '2608' }])).toBe('3 months');
    expect(seriesLine(PLAN.months[0]!.series[0]!)).toBe('2990-DraftOR-2606-001 – 043 (43)');
    expect(seriesLine({ series: 'x', count: 1, from: '2990-COR-2609-001', to: '2990-COR-2609-001' })).toBe('2990-COR-2609-001 (1)');
  });
});

describe('the Official receipts row', () => {
  it('shows the count and the numbers per month, runs only after the inline confirm, in batches, and reports the result', async () => {
    /* Batched (owner 2026-09-16): two calls, the second says nothing is left. */
    let posts = 0;
    authedFetch.mockImplementation((_path: string, init?: { method?: string }) => {
      if (init?.method === 'POST') { posts += 1; return Promise.resolve(posts === 1 ? { created: 30, formalised: 20, failed: [], remaining: 13 } : { created: 13, formalised: 13, failed: [], remaining: 0 }); }
      return Promise.resolve(PLAN);
    });
    draw();
    await waitFor(() => expect(screen.getByText('43 without one')).toBeTruthy());
    expect(screen.getByText('43 payments from June 2026 have none')).toBeTruthy();
    expect(screen.getByText('June 2026')).toBeTruthy();
    expect(screen.getByText('2990-DraftOR-2606-001 – 043 (43)')).toBeTruthy();
    expect(screen.getByText('2990-HOR-2606-001 – 021 (21)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create 43 receipts' }));
    expect(screen.getByText('Create 43 receipts now?')).toBeTruthy();
    expect(authedFetch).not.toHaveBeenCalledWith('/accounting/receipts/backfill', { method: 'POST' });
    fireEvent.click(screen.getByRole('button', { name: 'Create them' }));
    await waitFor(() => expect(authedFetch).toHaveBeenCalledWith('/accounting/receipts/backfill', { method: 'POST' }));
    await waitFor(() => expect(screen.getByText(/Created 43, formal 33, refused 0/)).toBeTruthy());
    expect(screen.getByText(/Every payment has one now/)).toBeTruthy();
    expect(posts).toBe(2);
    expect(onToast).toHaveBeenCalledWith('Created 43 official receipts · 33 formal');
  });

  it('Cancel runs nothing; a clean company reads clean; a failed read says so', async () => {
    authedFetch.mockResolvedValue(PLAN);
    draw();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create 43 receipts' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Create 43 receipts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(authedFetch).not.toHaveBeenCalledWith('/accounting/receipts/backfill', { method: 'POST' });
    cleanup();
    authedFetch.mockResolvedValue({ total: 0, months: [] });
    draw();
    await waitFor(() => expect(screen.getByText('Every payment has one')).toBeTruthy());
    expect(screen.getByText('Clean')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create/ })).toBeNull();
    cleanup();
    /* A 403 is a decision, not a blip: no retry, so the row answers at once. */
    authedFetch.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    draw();
    await waitFor(() => expect(screen.getByText(/not checked — the read failed/)).toBeTruthy());
  });
});
