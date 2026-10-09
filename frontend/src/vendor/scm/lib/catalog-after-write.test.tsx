// BUG-85: /mfg-products and /product-models answer with a 60s private max-age.
// A refetch that follows a write must skip that browser cache, or the SKU just
// made is missing and the stale list is then held as fresh. authed-fetch is
// mocked at the module seam (the accounting-queries-gl.test.tsx pattern).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from './authed-fetch';
import { useMfgProducts } from './mfg-products-queries';
import { useGenerateModelSkus, useProductModels } from './product-models-queries';

const mockedFetch = vi.mocked(authedFetch);

const withClient = (qc: QueryClient) => ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const initOf = (call: unknown[] | undefined) => call?.[1] as RequestInit | undefined;
const callsTo = (prefix: string) => mockedFetch.mock.calls.filter(([p]) => String(p).startsWith(prefix));

beforeEach(() => {
  mockedFetch.mockReset();
  mockedFetch.mockImplementation(async (path: string) => {
    if (path.startsWith('/mfg-products')) return { products: [] };
    if (path.startsWith('/product-models') && path.endsWith('/generate-skus')) return { generated: 1, skipped: 0, codes: ['BC06'] };
    if (path.startsWith('/product-models')) return { models: [] };
    return {};
  });
});

describe('useMfgProducts — the catalogue after a write', () => {
  test('a first read may use the browser cache', async () => {
    const { result } = renderHook(() => useMfgProducts(), { wrapper: withClient(newClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(initOf(callsTo('/mfg-products')[0])?.cache).toBeUndefined();
  });

  test('Add codes invalidates it, and the refetch goes past the browser cache', async () => {
    const qc = newClient();
    const { result } = renderHook(
      () => ({ list: useMfgProducts(), models: useProductModels(), gen: useGenerateModelSkus() }),
      { wrapper: withClient(qc) },
    );
    await waitFor(() => expect(result.current.list.isSuccess && result.current.models.isSuccess).toBe(true));

    await act(async () => { await result.current.gen.mutateAsync({ id: 'm-bc06', rows: [{ code: 'BC06', name: 'BACK CUSHION 06' }] }); });

    await waitFor(() => expect(callsTo('/mfg-products')).toHaveLength(2));
    expect(initOf(callsTo('/mfg-products')[1])?.cache).toBe('no-cache');
    // The Modular list (SKU count) is refetched too, also past the cache.
    await waitFor(() => expect(callsTo('/product-models').filter(([p]) => p === '/product-models')).toHaveLength(2));
    const modelReads = callsTo('/product-models').filter(([p]) => p === '/product-models');
    expect(initOf(modelReads[1])?.cache).toBe('no-cache');
  });

  test('fresh: the Assign dialog re-reads on open, past the browser cache, even over a cached list', async () => {
    const qc = newClient();
    const first = renderHook(() => useMfgProducts(), { wrapper: withClient(qc) });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    first.unmount();

    const dialog = renderHook(() => useMfgProducts({ fresh: true }), { wrapper: withClient(qc) });
    await waitFor(() => expect(callsTo('/mfg-products')).toHaveLength(2));
    await waitFor(() => expect(dialog.result.current.isFetching).toBe(false));
    expect(initOf(callsTo('/mfg-products')[1])?.cache).toBe('no-cache');
  });
});
