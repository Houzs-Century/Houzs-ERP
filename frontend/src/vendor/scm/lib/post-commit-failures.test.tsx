// The two COMMIT mutations — Post GRN and Post Purchase Invoice — must not
// report success they never established.
//
// WHY THIS FILE EXISTS. `usePostGrn` is the chokepoint where inventory is
// received into the warehouse (`postGrnAndRollup`: stock IN + the PO
// received-rollup) and `usePostPurchaseInvoice` is where an AP liability is
// booked. Both shipped with an `onSuccess` and NO `onError`, so a refused
// PATCH reached nobody:
//
//   * `GoodsReceivedDetailV2.doPost` confirms "Inventory will be received into
//     the warehouse" and then calls `postGrn.mutate(grn.id)` with no options.
//   * `GoodsReceivedListV2.doPost` passes `{ onSuccess }` only.
//   * `PurchaseInvoiceDetailV2.doPost` calls `postPi.mutate(id)` with no options.
//   * The global MutationCache (`lib/queryClient.ts`) carries only `onSuccess`.
//
// `check-silent-mutations.mjs` reports 0 SILENT and is not wrong within its own
// rules: its verdict is per HOOK, and ONE consumer that handles the failure
// clears every other consumer of the same hook. `GrnNew.tsx:696` awaits
// `post.mutateAsync(...)` inside a try/catch, so the hook was marked CAUGHT —
// and the three call sites that catch nothing were never looked at.
//
// The GRN post also carries an IN-BAND failure the frontend never read.
// `PATCH /grns/:id/post` answers 200 with `{ grn, movementErrors }`: the
// document posts and the stock movement is best-effort, so a refused inventory
// write is a SUCCESS as far as `onError` is concerned. `useCancelGrn`, ten
// lines above in the same file, already reads its `cancelErrors` through
// `reportInBandFailure` for exactly this reason.
//
// These tests assert the CONTRACT: a refusal, and a 200 that reports the stock
// did not move, both reach the operator. They fail on the pre-fix tree.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('./dialog-service', () => ({ serviceNotify: vi.fn(() => Promise.resolve(true)) }));

import { authedFetch } from './authed-fetch';
import { serviceNotify } from './dialog-service';
import { usePostGrn } from './grn-queries';
import { usePostPurchaseInvoice } from './purchase-invoice-queries';

const mockedFetch = vi.mocked(authedFetch);
const mockedNotify = vi.mocked(serviceNotify);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => { mockedFetch.mockReset(); mockedNotify.mockReset(); });

/** Every word the operator was shown, joined — title and body both count. */
const saidOutLoud = () =>
  mockedNotify.mock.calls.map((c) => `${c[0].title} ${c[0].body}`).join(' | ');

describe('Post GRN — the stock-IN commit', () => {
  test('a refused post is said out loud, not swallowed', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('This GRN has a zero-cost line.'));
    const { result } = renderHook(() => usePostGrn(), { wrapper });
    result.current.mutate('grn-1');
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockedNotify).toHaveBeenCalled();
    expect(saidOutLoud()).toMatch(/zero-cost line/i);
  });

  test('a 200 that reports the stock did NOT move is said out loud', async () => {
    // The document posted; the inventory IN did not. onError never fires here.
    mockedFetch.mockResolvedValueOnce({
      grn: { id: 'grn-1' },
      movementErrors: ['IN GRN-2608-004: warehouse not resolved'],
    });
    const { result } = renderHook(() => usePostGrn(), { wrapper });
    result.current.mutate('grn-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedNotify).toHaveBeenCalled();
    expect(saidOutLoud()).toMatch(/warehouse not resolved/i);
    // The wording must NOT tell them to post again — the GRN IS posted.
    expect(saidOutLoud()).toMatch(/saved|posted/i);
  });

  test('a clean 200 says nothing — silence is still correct on success', async () => {
    mockedFetch.mockResolvedValueOnce({ grn: { id: 'grn-1' } });
    const { result } = renderHook(() => usePostGrn(), { wrapper });
    result.current.mutate('grn-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedNotify).not.toHaveBeenCalled();
  });
});

describe('Post Purchase Invoice — the AP commit', () => {
  test('a refused post is said out loud, not swallowed', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('The supplier is not resolved for this company.'));
    const { result } = renderHook(() => usePostPurchaseInvoice(), { wrapper });
    result.current.mutate('pi-1');
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(mockedNotify).toHaveBeenCalled();
    expect(saidOutLoud()).toMatch(/supplier is not resolved/i);
  });

  test('a clean 200 says nothing', async () => {
    mockedFetch.mockResolvedValueOnce({ id: 'pi-1' });
    const { result } = renderHook(() => usePostPurchaseInvoice(), { wrapper });
    result.current.mutate('pi-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedNotify).not.toHaveBeenCalled();
  });
});
