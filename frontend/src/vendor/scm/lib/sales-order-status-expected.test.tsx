/* The status PATCH's optimistic-concurrency payload.
 *
 * `expectedStatus` is the server's CAS on the status column: the backend
 * refuses with 409 `so_version_conflict` when it does not equal the row's
 * CURRENT status. It must therefore carry the status the screen was showing
 * BEFORE the click — never the status being moved to.
 *
 * onMutate paints the target status onto the detail cache, and react-query
 * runs onMutate BEFORE mutationFn, so a mutationFn that reads the status out
 * of that same cache reads its own optimistic write. This pins that it does
 * not. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.fn();

vi.mock('./authed-fetch', () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
  API_URL: 'http://test',
  humanApiError: (_s: number, b: string) => b,
}));
vi.mock('./dialog-service', () => ({ serviceNotify: vi.fn() }));

const { useUpdateMfgSalesOrderStatus } = await import('./sales-order-queries');

const bodyOf = (init: unknown) =>
  JSON.parse((init as { body: string }).body) as Record<string, unknown>;

describe('useUpdateMfgSalesOrderStatus — expectedStatus', () => {
  beforeEach(() => authedFetch.mockReset());

  it('sends the status the order is currently ON, not the one it is moving to', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    qc.setQueryData(['mfg-sales-order-detail', 'HC-SO-2608-001'], {
      salesOrder: { doc_no: 'HC-SO-2608-001', status: 'CONFIRMED', version: 4 },
      items: [],
    });
    authedFetch.mockResolvedValue({ salesOrder: {}, version: 5 });

    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useUpdateMfgSalesOrderStatus(), { wrapper });

    result.current.mutate({ docNo: 'HC-SO-2608-001', status: 'cancelled', expectedStatus: 'CONFIRMED' });
    await waitFor(() => expect(authedFetch).toHaveBeenCalled());

    const sent = bodyOf(authedFetch.mock.calls[0]![1]);
    expect(sent.version).toBe(4);
    expect(sent.status).toBe('cancelled');
    expect(sent.expectedStatus).toBe('CONFIRMED');
  });

  it('omits the status CAS — never asserts a wrong one — when the caller passes null', async () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    qc.setQueryData(['mfg-sales-order-detail', 'HC-SO-2608-002'], {
      salesOrder: { doc_no: 'HC-SO-2608-002', status: 'CONFIRMED', version: 2 },
      items: [],
    });
    authedFetch.mockResolvedValue({ salesOrder: {}, version: 3 });

    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useUpdateMfgSalesOrderStatus(), { wrapper });

    result.current.mutate({ docNo: 'HC-SO-2608-002', status: 'cancelled', expectedStatus: null });
    await waitFor(() => expect(authedFetch).toHaveBeenCalled());

    const sent = bodyOf(authedFetch.mock.calls[0]![1]);
    expect(sent.version).toBe(2);
    expect('expectedStatus' in sent).toBe(false);
  });
});
