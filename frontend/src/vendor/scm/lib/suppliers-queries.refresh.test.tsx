// Changing a supplier must refresh the paged Suppliers list, not only the detail
// page: the list keeps its rows for 30 seconds, so a missed refresh showed the
// old values on the way back (Conts-ERP #406).
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn(async () => ({ supplier: { id: 's1' } })) }));

import { useCreateSupplier, useUpdateSupplier } from './suppliers-queries';

const PAGED = ['suppliers-paged', 0, 50, '', '', '', '', ''];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(PAGED, { suppliers: [], total: 0, page: 0, pageSize: 50 });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

describe('a supplier change refreshes the paged list', () => {
  test('an update marks the Suppliers list stale', async () => {
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useUpdateSupplier(), { wrapper });
    await result.current.mutateAsync({ id: 's1', name: 'AD DESIGN' });
    await waitFor(() => expect(qc.getQueryState(PAGED)?.isInvalidated).toBe(true));
  });

  test('a new supplier marks the Suppliers list stale', async () => {
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => useCreateSupplier(), { wrapper });
    await result.current.mutateAsync({ name: 'NEW' });
    await waitFor(() => expect(qc.getQueryState(PAGED)?.isInvalidated).toBe(true));
  });
});
