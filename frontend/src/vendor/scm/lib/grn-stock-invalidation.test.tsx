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
import { serviceNotify } from './dialog-service';
import {
  useCreateGrn,
  usePostGrn,
  useCancelGrn,
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

/* Symptom: "Back to PO" after a receipt showed the old received qty, and a line added or edited on a posted receipt
   read as clean when its stock write or PO recount was refused.
   Cause: the hooks refreshed only the GRN keys and read no in-band failure from the line answers.
   Fix: every receipt write also refreshes the PO keys; line add / edit report movementErrors and recountError. */
const invalidatedRoot = (spy: { mock: { calls: unknown[][] } }, root: string): boolean =>
  spy.mock.calls.some((args) => {
    const f = args[0] as { queryKey?: unknown[] } | undefined;
    return Array.isArray(f?.queryKey) && f.queryKey[0] === root;
  });

describe('GRN writes refresh the purchase order they received against', () => {
  test.each([
    ['useCreateGrn', () => useCreateGrn(), { id: 'grn-1', grnNumber: 'GRN-1' }, {}],
    ['usePostGrn', () => usePostGrn(), { grn: {} }, 'grn-1'],
    ['useCancelGrn', () => useCancelGrn(), { grn: {} }, 'grn-1'],
    ['useAddGrnItem', () => useAddGrnItem(), { item: { id: 'gi-1' } }, { grnId: 'grn-1', itemCode: 'X' }],
    ['useUpdateGrnItem', () => useUpdateGrnItem(), { ok: true }, { grnId: 'grn-1', itemId: 'gi-1', qty: 3 }],
  ] as const)('%s refreshes the PO list and detail', async (_n, hook, answer, vars) => {
    mockedFetch.mockResolvedValueOnce(answer);
    const { spy, wrapper } = harness();
    const { result } = renderHook(hook as () => { mutate: (v: unknown) => void; isSuccess: boolean }, { wrapper });
    result.current.mutate(vars);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidatedRoot(spy, 'mfg-purchase-orders')).toBe(true);
    expect(invalidatedRoot(spy, 'mfg-purchase-order-detail')).toBe(true);
  });
});

describe('a posted-receipt line write whose stock was refused says so', () => {
  test('line add with movementErrors is reported', async () => {
    vi.mocked(serviceNotify).mockClear();
    mockedFetch.mockResolvedValueOnce({ item: { id: 'gi-1' }, movementErrors: ['IN X: refused'] });
    const { wrapper } = harness();
    const { result } = renderHook(() => useAddGrnItem(), { wrapper });
    result.current.mutate({ grnId: 'grn-1', itemCode: 'X' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(vi.mocked(serviceNotify)).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(serviceNotify).mock.calls)).toContain('IN X: refused');
  });

  test('line edit with recountError is reported', async () => {
    vi.mocked(serviceNotify).mockClear();
    mockedFetch.mockResolvedValueOnce({ ok: true, recountError: 'po recount timed out' });
    const { wrapper } = harness();
    const { result } = renderHook(() => useUpdateGrnItem(), { wrapper });
    result.current.mutate({ grnId: 'grn-1', itemId: 'gi-1', qty: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await waitFor(() => expect(vi.mocked(serviceNotify)).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(serviceNotify).mock.calls)).toContain('po recount timed out');
  });

  test('a clean line edit says nothing', async () => {
    vi.mocked(serviceNotify).mockClear();
    mockedFetch.mockResolvedValueOnce({ ok: true });
    const { wrapper } = harness();
    const { result } = renderHook(() => useUpdateGrnItem(), { wrapper });
    result.current.mutate({ grnId: 'grn-1', itemId: 'gi-1', qty: 3 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(vi.mocked(serviceNotify)).not.toHaveBeenCalled();
  });
});
