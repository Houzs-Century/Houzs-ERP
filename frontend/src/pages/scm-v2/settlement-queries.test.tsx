// The settlement hooks' contract is the URL + verb + body each one sends — so
// that is what these pin, the same way accounting-phase1-queries.test.tsx does.
// authed-fetch is mocked at the module seam: no network, no component tree.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import {
  useAcquirerSetup, useSaveAcquirerSetup, useSettlementBatches, useSettlementBatch,
  useUploadStatement, useConfirmSettlementRow, useConfirmMatched, useIgnoreSettlementRow,
  useSettlementWatchlist, usePayouts, useUploadPayoutAdvice,
} from './settlement-queries';

const mockedFetch = vi.mocked(authedFetch);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => { mockedFetch.mockReset(); });

describe('the reads', () => {
  test('useAcquirerSetup reads GET /accounting/settlement/setup', async () => {
    mockedFetch.mockResolvedValueOnce({ acquirers: [] });
    const { result } = renderHook(() => useAcquirerSetup(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/settlement/setup');
  });

  test('useSettlementBatches and useSettlementBatch read the list and one batch', async () => {
    mockedFetch.mockResolvedValueOnce({ batches: [] });
    const list = renderHook(() => useSettlementBatches(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/settlement/batches');

    mockedFetch.mockResolvedValueOnce({ batch: {}, acquirer: {}, buckets: {}, rows: [] });
    const one = renderHook(() => useSettlementBatch(9), { wrapper });
    await waitFor(() => expect(one.result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/settlement/batches/9');
  });

  test('useSettlementBatch stays idle until there is a batch to read', () => {
    const { result } = renderHook(() => useSettlementBatch(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  test('useSettlementWatchlist puts its window in the query string, and omits it when empty', async () => {
    mockedFetch.mockResolvedValueOnce({ from: '', to: '', clean: true, recordedNotArrived: [], arrivedNotRecorded: [] });
    const filtered = renderHook(() => useSettlementWatchlist({ from: '2026-08-01', to: '2026-08-16', acquirer: 'MBB' }), { wrapper });
    await waitFor(() => expect(filtered.result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/settlement/watchlist?from=2026-08-01&to=2026-08-16&acquirer=MBB');

    mockedFetch.mockResolvedValueOnce({ from: '', to: '', clean: true, recordedNotArrived: [], arrivedNotRecorded: [] });
    const plain = renderHook(() => useSettlementWatchlist(), { wrapper });
    await waitFor(() => expect(plain.result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/settlement/watchlist');
  });
});

describe('the writes', () => {
  test('useUploadStatement posts the file content to the batches endpoint', async () => {
    mockedFetch.mockResolvedValueOnce({ batchId: 3, rows: 2, buckets: {} });
    const { result } = renderHook(() => useUploadStatement(), { wrapper });
    result.current.mutate({ acquirerCode: 'MBB', fileName: 'aug.csv', content: 'a,b\n1,2', summaryFeeSen: null });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/settlement/batches');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ acquirerCode: 'MBB', fileName: 'aug.csv' });
  });

  test('useSaveAcquirerSetup PATCHes the code in the path, not the body', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => useSaveAcquirerSetup(), { wrapper });
    result.current.mutate({ code: 'GHL', hasUniqueRef: false, dateToleranceDays: 5 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/settlement/setup/GHL');
    expect(init?.method).toBe('PATCH');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ hasUniqueRef: false, dateToleranceDays: 5 });
    expect(body.code).toBeUndefined();
  });

  test('useConfirmSettlementRow sends the whole selection — one settlement may cover several orders', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 'confirmed', jeNo: 'JE-2608-0007' });
    const { result } = renderHook(() => useConfirmSettlementRow(), { wrapper });
    result.current.mutate({
      rowId: 7, matchReason: 'manual',
      payments: [
        { source: 'SOPAY', id: 'p1', docNo: 'SO-1', amountSen: 60000 },
        { source: 'SOPAY', id: 'p2', docNo: 'SO-2', amountSen: 40000 },
      ],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/settlement/rows/7/confirm');
    const body = JSON.parse(String(init?.body));
    expect(body.payments).toHaveLength(2);
    expect(body.rowId).toBeUndefined();
  });

  test('useConfirmMatched and useIgnoreSettlementRow hit their own endpoints', async () => {
    mockedFetch.mockResolvedValueOnce({ attempted: 2, confirmed: 2, failed: [] });
    const bulk = renderHook(() => useConfirmMatched(), { wrapper });
    bulk.result.current.mutate(4);
    await waitFor(() => expect(bulk.result.current.isSuccess).toBe(true));
    expect(mockedFetch.mock.calls[0]![0]).toBe('/accounting/settlement/batches/4/confirm-matched');

    mockedFetch.mockResolvedValueOnce({ ok: true });
    const ignore = renderHook(() => useIgnoreSettlementRow(), { wrapper });
    ignore.result.current.mutate({ rowId: 11, notes: 'duplicate' });
    await waitFor(() => expect(ignore.result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[1]!;
    expect(path).toBe('/accounting/settlement/rows/11/ignore');
    expect(JSON.parse(String(init?.body))).toMatchObject({ restore: false, notes: 'duplicate' });
  });
});

describe('the payment advice', () => {
  test('usePayouts reads GET /accounting/settlement/payouts', async () => {
    mockedFetch.mockResolvedValueOnce({ payouts: [] });
    const { result } = renderHook(() => usePayouts(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/settlement/payouts');
  });

  test('useUploadPayoutAdvice posts the PDF as base64, never as text', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, payoutId: 2, status: { netSen: 0, days: [], readyToReceive: false, blockedBy: null } });
    const { result } = renderHook(() => useUploadPayoutAdvice(), { wrapper });
    result.current.mutate({
      acquirerCode: 'PBB',
      fileName: 'HOUZSCENTURY_IBG_100826.pdf',
      contentBase64: 'data:application/pdf;base64,JVBERi0xLjQ=',
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/settlement/payouts');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      acquirerCode: 'PBB',
      contentBase64: 'data:application/pdf;base64,JVBERi0xLjQ=',
    });
  });
});
