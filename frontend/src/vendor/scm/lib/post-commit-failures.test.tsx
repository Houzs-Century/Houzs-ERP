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
    mockedFetch.mockResolvedValueOnce({
      grn: { id: 'grn-1' },
      movementErrors: ['IN GRN-2608-004: warehouse not resolved'],
    });
    const { result } = renderHook(() => usePostGrn(), { wrapper });
    result.current.mutate('grn-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedNotify).toHaveBeenCalled();
    expect(saidOutLoud()).toMatch(/warehouse not resolved/i);
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
