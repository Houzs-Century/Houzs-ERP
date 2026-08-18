// useMfgSalesOrdersPaged's `enabled` gate — the fix for the SO-list double
// fetch. The list page defers its FIRST fetch by one render (enabled:false)
// until the DataTable reports its localStorage-restored sort, so the one and
// only query already carries `sort`. These tests pin that gate: no fetch while
// disabled, and the sort param on the wire once enabled. authed-fetch is mocked
// at the module seam (the so-versioned-mutation.test.ts / accounting pattern).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({
  authedFetch: vi.fn(),
  API_URL: 'http://test.local/api/scm',
  humanApiError: (e: unknown) => String(e),
}));
vi.mock('./mutation-error', () => ({ writeFailed: () => {}, writeFailedAs: () => () => {} }));

import { authedFetch } from './authed-fetch';
import { useMfgSalesOrdersPaged } from './sales-order-queries';

const mockedFetch = vi.mocked(authedFetch);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => { mockedFetch.mockReset(); });

describe('useMfgSalesOrdersPaged — the enabled gate', () => {
  test('enabled:false fires no fetch (the deferred first render)', async () => {
    const { result } = renderHook(
      () => useMfgSalesOrdersPaged({ page: 1, pageSize: 25, sort: 'so_date:desc', enabled: false }),
      { wrapper },
    );
    // Give React Query a beat; a disabled query must never touch the network.
    await Promise.resolve();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe('idle');
  });

  test('once enabled the single fetch already carries the restored sort', async () => {
    mockedFetch.mockResolvedValueOnce({ salesOrders: [], total: 0, page: 1, pageSize: 25, statusCounts: { all: 0, draft: 0, confirmed: 0, cancelled: 0 } });
    const { result } = renderHook(
      () => useMfgSalesOrdersPaged({ page: 1, pageSize: 25, sort: 'so_date:desc', enabled: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [path] = mockedFetch.mock.calls[0]!;
    expect(String(path)).toContain('sort=so_date%3Adesc');
  });

  test('enabled defaults to true (other callers pass no gate)', async () => {
    mockedFetch.mockResolvedValueOnce({ salesOrders: [], total: 0, page: 1, pageSize: 25, statusCounts: { all: 0, draft: 0, confirmed: 0, cancelled: 0 } });
    const { result } = renderHook(
      () => useMfgSalesOrdersPaged({ page: 1, pageSize: 200, sort: '-so_date' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
