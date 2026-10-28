// Saving a Model's allowed options auto-creates the SKU for each newly ticked
// sofa compartment (PATCH /product-models/:id). The SO/PO picker reads the
// ['mfg-products'] catalogue with a 5-minute staleTime, so the save must
// invalidate it or the new code cannot be found on a new SO (BUG-41).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from './authed-fetch';
import { useUpdateProductModel } from './product-models-queries';

test('useUpdateProductModel invalidates the SKU catalogue the SO/PO picker reads', async () => {
  vi.mocked(authedFetch).mockResolvedValueOnce({ model: { id: 'm-1' }, autoCreatedSkus: ['8030-2B(LHF)'] });
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useUpdateProductModel(), { wrapper });
  result.current.mutate({ id: 'm-1', allowedOptions: { compartments: ['2B(LHF)'] } });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const roots = spy.mock.calls.map((args) => (args[0] as { queryKey?: unknown[] } | undefined)?.queryKey?.[0]);
  expect(roots).toContain('mfg-products');
  expect(roots).toContain('model-allowed-options-by-code');
});
