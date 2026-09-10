// Every GRN mutation that moves inventory server-side must invalidate
// ['inventory'], so a mounted Stock Card / inventory list refetches on-hand.
//
// WHY THIS FILE EXISTS. docs/modules/grn.md §1 states the rule: "every mutation
// that can move inventory also invalidates ['inventory']". Only usePostGrn and
// useCancelGrn followed it. Five more hooks move stock — useGrnFromPos auto-posts
// a whole-PO convert (stock IN), useUpdateGrnHeader relocates a POSTED GRN's
// warehouse (OUT+IN), and the three line-CRUD hooks re-sync a POSTED GRN
// (add → IN, edit → delta OUT/IN, delete → reversing OUT) — yet each invalidated
// only ['grn-detail'] + ['grns'], leaving stock views stale after a posted-GRN
// line change or a From-PO convert. docs/bugs/0780.
//
// These tests assert the CONTRACT (a stock-moving success invalidates the
// inventory root); they fail on the pre-fix tree.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('./dialog-service', () => ({ serviceNotify: vi.fn(() => Promise.resolve(true)) }));

import { authedFetch } from './authed-fetch';
import {
  useGrnFromPos,
  useUpdateGrnHeader,
  useAddGrnItem,
  useUpdateGrnItem,
  useDeleteGrnItem,
} from './grn-queries';

const mockedFetch = vi.mocked(authedFetch);

function harness() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { spy, wrapper };
}

/** Did any invalidateQueries call target the ['inventory'] root? */
const invalidatedInventory = (spy: { mock: { calls: unknown[][] } }): boolean =>
  spy.mock.calls.some((args) => {
    const f = args[0] as { queryKey?: unknown[] } | undefined;
    return Array.isArray(f?.queryKey) && f.queryKey[0] === 'inventory';
  });

beforeEach(() => { mockedFetch.mockReset(); });

describe("GRN stock-moving mutations invalidate ['inventory']", () => {
  test('useGrnFromPos — whole-PO convert auto-posts (stock IN)', async () => {
    mockedFetch.mockResolvedValueOnce({ id: 'grn-1', grnNumber: 'GRN-1', poCount: 1, lineCount: 2 });
    const { spy, wrapper } = harness();
    const { result } = renderHook(() => useGrnFromPos(), { wrapper });
    result.current.mutate({ purchaseOrderIds: ['po-1'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedInventory(spy)).toBe(true);
  });

  test('useUpdateGrnHeader — warehouse relocation (OUT+IN)', async () => {
    mockedFetch.mockResolvedValueOnce({ grn: { id: 'grn-1' } });
    const { spy, wrapper } = harness();
    const { result } = renderHook(() => useUpdateGrnHeader(), { wrapper });
    result.current.mutate({ id: 'grn-1', warehouseId: 'wh-2' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedInventory(spy)).toBe(true);
  });

  test('useAddGrnItem — line added to a POSTED GRN (IN)', async () => {
    mockedFetch.mockResolvedValueOnce({ item: { id: 'gi-1' } });
    const { spy, wrapper } = harness();
    const { result } = renderHook(() => useAddGrnItem(), { wrapper });
    result.current.mutate({ grnId: 'grn-1', itemCode: 'X' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedInventory(spy)).toBe(true);
  });

  test('useUpdateGrnItem — line edited on a POSTED GRN (delta OUT/IN)', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true });
    const { spy, wrapper } = harness();
    const { result } = renderHook(() => useUpdateGrnItem(), { wrapper });
    result.current.mutate({ grnId: 'grn-1', itemId: 'gi-1', qtyAccepted: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedInventory(spy)).toBe(true);
  });

  test('useDeleteGrnItem — line removed from a POSTED GRN (reversing OUT)', async () => {
    mockedFetch.mockResolvedValueOnce(undefined);
    const { spy, wrapper } = harness();
    const { result } = renderHook(() => useDeleteGrnItem(), { wrapper });
    result.current.mutate({ grnId: 'grn-1', itemId: 'gi-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedInventory(spy)).toBe(true);
  });
});
