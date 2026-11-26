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

describe('useUpdateMfgSalesOrderStatus — cancellation card', () => {
  beforeEach(() => authedFetch.mockReset());

  const run = async (docNo: string, status: string) => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
    qc.setQueryData(['mfg-sales-order-detail', docNo], { salesOrder: { doc_no: docNo, status: 'CONFIRMED', version: 1 }, items: [] });
    qc.setQueryData(['document-cancel-request', 'so', docNo], { open: { status: 'APPROVED' } });
    qc.setQueryData(['document-cancel-requests', 'open'], { requests: [] });
    authedFetch.mockResolvedValue({ salesOrder: {}, version: 2 });
    const wrapper = ({ children }: { children: ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useUpdateMfgSalesOrderStatus(), { wrapper });
    await result.current.mutateAsync({ docNo, status, expectedStatus: 'CONFIRMED' });
    await waitFor(() => expect(qc.getQueryState(['mfg-sales-order-detail', docNo])?.isInvalidated).toBe(true));
    return qc;
  };

  it('refreshes the cancel card and the inbox when the order is cancelled', async () => {
    const qc = await run('HC-SO-2611-010', 'CANCELLED');
    expect(qc.getQueryState(['document-cancel-request', 'so', 'HC-SO-2611-010'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['document-cancel-requests', 'open'])?.isInvalidated).toBe(true);
  });

  it('leaves them alone on any other status change', async () => {
    const qc = await run('HC-SO-2611-011', 'IN_PRODUCTION');
    expect(qc.getQueryState(['document-cancel-request', 'so', 'HC-SO-2611-011'])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(['document-cancel-requests', 'open'])?.isInvalidated).toBe(false);
  });
});
