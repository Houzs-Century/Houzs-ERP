/* Books › Self-check in the owner's redesign (batch 6 §3). Pinned: the three
   groups and their rows; a control account reads its ledger balance (Cr on
   the creditor side), its findings open by default with the documents and
   the foreign lines; a check that could not run reads "Not checked", never
   clean; the cancelled orders still holding money list each order with what
   is left; the subtitle counts the checks and what needs looking at; Run
   again re-reads every check. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const { useControlCheck, useCancelledWithMoney, useReceiptBackfillPlan, runSelfCheck } = vi.hoisted(() => ({
  useControlCheck: vi.fn(), useCancelledWithMoney: vi.fn(), useReceiptBackfillPlan: vi.fn(), runSelfCheck: vi.fn(),
}));
vi.mock('./accounting-phase1-queries', async (orig) => ({
  ...(await orig<Record<string, unknown>>()), useControlCheck, useRunSelfCheck: () => ({ mutateAsync: runSelfCheck, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/so-money-queries', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useCancelledWithMoney }));
vi.mock('./receipt-backfill-queries', async (orig) => ({ ...(await orig<Record<string, unknown>>()), useReceiptBackfillPlan }));

import { SelfCheckTab, controlTitle, selfCheckCounts } from './SelfCheck';

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/scm/accounting?tab=check']}>{ui}</MemoryRouter>
  </QueryClientProvider>
);

const CHECKS = {
  checks: [
    { role: 'AR', accountCode: '300-0000', glBalanceSen: 43_815_700, ok: false,
      driftDocs: [{ docNo: 'HC-SI-2610-0088', docTotalSen: 245_000, jeTotalSen: 233_000, diffSen: -12_000, note: 'journal total differs from document total',
        party: 'Lim Kah Hoe', date: '2026-10-24', jeNo: 'HC-JE-2610-0851', docKind: 'SI', docId: 'si-88' }],
      foreignLines: [{ jeNo: 'HC-JE-2610-0100', sourceType: 'MANUAL', debitSen: 5_000, creditSen: 0 }] },
    { role: 'AR_OTHER', accountCode: '305-0000', glBalanceSen: 1_024_500, ok: true, driftDocs: [], foreignLines: [] },
    { role: 'AP', accountCode: '400-0000', glBalanceSen: -29_712_100, ok: true, driftDocs: [], foreignLines: [] },
    { role: 'AP_OTHER', accountCode: '405-0000', error: 'v_gl_entries: timeout' },
  ],
  payments: { since: '2026-06-01', rows: [], totalSen: 0, ok: true },
  paymentDrift: { rows: [], scanned: 1_284, ok: true },
};
const refetch = (data: unknown) => vi.fn(async () => ({ data, isError: false }));

beforeEach(() => {
  useControlCheck.mockReturnValue({ data: CHECKS, isLoading: false, isError: false, dataUpdatedAt: Date.UTC(2026, 9, 29, 8, 40), refetch: refetch(CHECKS) });
  const cancelled = { orders: [{ docNo: 'HC-SO-2610-0366', customer: 'Hafizah Ismail', status: 'CANCELLED', cancelledOn: '2026-10-09', remainingSen: 150_000, bookedSen: 150_000, movableSen: 150_000, keepSen: 0 }], totalRemainingSen: 150_000 };
  useCancelledWithMoney.mockReturnValue({ data: cancelled, isLoading: false, isError: false, dataUpdatedAt: Date.UTC(2026, 9, 29, 8, 40), refetch: refetch(cancelled) });
  const plan = { total: 0, months: [] };
  useReceiptBackfillPlan.mockReturnValue({ data: plan, isLoading: false, isError: false, dataUpdatedAt: Date.UTC(2026, 9, 29, 8, 40), refetch: refetch(plan) });
});
afterEach(cleanup);

const rowOf = (id: string) => document.querySelector(`[data-check="${id}"]`) as HTMLElement;

describe('Self-check', () => {
  it('names the controls the way Finance does', () => {
    expect(['AR', 'AR_OTHER', 'AP', 'AP_OTHER'].map(controlTitle)).toEqual(['Trade debtors', 'Other debtors', 'Trade creditors', 'Other creditors']);
  });

  it('three groups; a control reads its balance, its findings open with the documents and the foreign lines', () => {
    render(wrap(<SelfCheckTab />));
    for (const g of ['Control accounts against their documents', 'Payments and their entries', 'Money the books are not done with']) expect(screen.getByText(g)).toBeTruthy();
    expect(screen.getByText('Finance · Books')).toBeTruthy();
    const ar = rowOf('control-300-0000');
    expect(within(ar).getByText('Trade debtors')).toBeTruthy();
    expect(within(ar).getByText('300-0000 · balance in the ledger')).toBeTruthy();
    expect(within(ar).getByText('RM 438,157.00')).toBeTruthy();
    expect(within(ar).getByText('2 findings')).toBeTruthy();
    /* Open by default: the document (a link to the invoice), who, when, its entry, the totals; the foreign line. */
    expect(within(ar).getByRole('button', { name: 'HC-SI-2610-0088' })).toBeTruthy();
    expect(within(ar).getByText('Lim Kah Hoe')).toBeTruthy();
    expect(within(ar).getByText('2026/10/24')).toBeTruthy();
    expect(within(ar).getByText('HC-JE-2610-0851')).toBeTruthy();
    expect(within(ar).getByText('(120.00)')).toBeTruthy();
    expect(within(ar).getByText(/Lines on this account from sources that do not belong here: HC-JE-2610-0100 \(MANUAL\)/)).toBeTruthy();
    /* A clean control is one line; a creditor's balance reads Cr. */
    const ap = rowOf('control-400-0000');
    expect(within(ap).getByText('RM 297,121.00 Cr')).toBeTruthy();
    expect(within(ap).getByText('Clean')).toBeTruthy();
    expect(within(ap).queryByRole('button')).toBeNull();
    /* A check that could not run is not clean. */
    const apo = rowOf('control-405-0000');
    expect(within(apo).getByText('Not checked')).toBeTruthy();
    expect(within(apo).getByText(/could not run: v_gl_entries: timeout/)).toBeTruthy();
  });

  it('cancelled orders list each order with what is left; the subtitle counts what to look at', () => {
    render(wrap(<SelfCheckTab />));
    const row = rowOf('cancelled');
    expect(within(row).getByText('1 order')).toBeTruthy();
    expect(within(row).getByText('RM 1,500.00')).toBeTruthy();
    expect(within(row).getByText('HC-SO-2610-0366 · Hafizah Ismail')).toBeTruthy();
    expect(within(row).getByText(/Refund and Convert are on the order’s money panel/)).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'HC-SO-2610-0366' })).toBeTruthy();
    /* AR (findings), Other creditors (not checked), the cancelled order: 3 of 8. */
    expect(screen.getByText(/· 8 checks · 3 to look at/)).toBeTruthy();
    expect(within(rowOf('agree')).getByText('all 1284')).toBeTruthy();
    expect(within(rowOf('receipts')).getByText('Every payment has one')).toBeTruthy();
  });

  it('Run again asks the server to run the checks, takes the reads it returns, and says what it found', async () => {
    runSelfCheck.mockResolvedValueOnce({
      control: CHECKS, cancelled: { orders: [], totalRemainingSen: 0 }, receipts: { total: 0, months: [] },
      summary: { checks: 8, findings: 2, items: ['x', 'y'] }, ranAt: '2026-11-03T08:00:00Z',
    });
    render(wrap(<SelfCheckTab />));
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(screen.getByText('Self-check ran · 2 to look at')).toBeTruthy());
    expect(runSelfCheck).toHaveBeenCalledTimes(1);
    expect(useControlCheck.mock.results.at(-1)!.value.refetch).not.toHaveBeenCalled();
  });

  it('a run the server refuses falls back to reading every check again', async () => {
    runSelfCheck.mockRejectedValueOnce(new Error("You don't have permission to run the self-check."));
    render(wrap(<SelfCheckTab />));
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(screen.getByText('Self-check ran · 3 to look at')).toBeTruthy());
    expect(useControlCheck.mock.results.at(-1)!.value.refetch).toHaveBeenCalled();
    expect(useCancelledWithMoney.mock.results.at(-1)!.value.refetch).toHaveBeenCalled();
    expect(useReceiptBackfillPlan.mock.results.at(-1)!.value.refetch).toHaveBeenCalled();
  });

  it('a failed read is counted to look at, never read as clean', () => {
    expect(selfCheckCounts({ checks: [], payments: null, drift: null, cancelled: null, receipts: 0 }).toLook).toBe(1);
    useCancelledWithMoney.mockReturnValue({ data: undefined, isLoading: false, isError: true, dataUpdatedAt: 0, refetch: refetch(undefined) });
    render(wrap(<SelfCheckTab />));
    expect(within(rowOf('cancelled')).getByText('Not checked')).toBeTruthy();
  });
});
