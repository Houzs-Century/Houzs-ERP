// The SO list's second-level filters as URL state — the ONE layer the phone
// sheet and the desktop bar both read and write (owner rule: one shared logic
// layer, surfaces differ only in presentation; URL is state). Pinned here:
// what reaches the URL, what reaches the API, and that a stale page index and
// half-built rows never leak into either.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
import {
  appendSoListFilterParams,
  draftAdd,
  draftChangeField,
  draftRemove,
  draftUpdate,
  readSoListFilters,
  useSoListCountPreview,
  useSoListFilters,
  writeSoListFilters,
} from './so-list-filter-state';

const mockedFetch = vi.mocked(authedFetch);
beforeEach(() => { mockedFetch.mockReset(); });

const wrap = (initial: string) => ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  </QueryClientProvider>
);

describe('URL encoding', () => {
  test('reads valid rows in order and drops a hand-edited invalid one', () => {
    const p = new URLSearchParams('status=confirmed&f=createdBy:me&f=balance:gt:abc&f=venue:contains:IOI');
    expect(readSoListFilters(p)).toEqual([
      { field: 'createdBy', op: 'me', value: '' },
      { field: 'venue', op: 'contains', value: 'IOI' },
    ]);
  });

  test('writing replaces every f, resets the page, keeps everything else, and skips incomplete rows', () => {
    const p = new URLSearchParams('status=confirmed&q=tan&page=4&f=old:x&view=cards');
    const next = writeSoListFilters(p, [
      { field: 'balance', op: 'positive', value: '' },
      { field: 'name', op: 'contains', value: '' },
    ]);
    expect(next.getAll('f')).toEqual(['balance:positive']);
    expect(next.get('page')).toBeNull();
    expect(next.get('status')).toBe('confirmed');
    expect(next.get('q')).toBe('tan');
    expect(next.get('view')).toBe('cards');
    expect(p.get('page')).toBe('4');
  });

  test('the API params carry only complete rows', () => {
    const usp = new URLSearchParams();
    appendSoListFilterParams(usp, [
      { field: 'createdBy', op: 'me', value: '' },
      { field: 'venue', op: 'contains', value: '  ' },
    ]);
    expect(usp.getAll('f')).toEqual(['createdBy:me']);
  });
});

describe('draft editing', () => {
  test('add, change field, update and remove', () => {
    let d = draftAdd([], 'name');
    expect(d).toEqual([{ field: 'name', op: 'contains', value: '' }]);
    d = draftUpdate(d, 0, { value: 'tan' });
    d = draftAdd(d, 'deliveryDate');
    expect(d[1]).toEqual({ field: 'deliveryDate', op: 'preset', value: 'this_week' });
    d = draftChangeField(d, 0, 'balance');
    expect(d[0]).toEqual({ field: 'balance', op: 'positive', value: '' });
    d = draftRemove(d, 0);
    expect(d).toHaveLength(1);
  });
});

describe('useSoListFilters', () => {
  test('apply writes status + rows to the URL and clear removes both', () => {
    const { result } = renderHook(() => ({ f: useSoListFilters(), loc: useLocation() }), {
      wrapper: wrap('/scm/sales-orders?page=3&q=tan'),
    });
    expect(result.current.f.filters).toEqual([]);
    expect(result.current.f.status).toBe('all');

    act(() => result.current.f.apply({ status: 'confirmed', filters: [{ field: 'createdBy', op: 'me', value: '' }] }));
    const after = new URLSearchParams(result.current.loc.search);
    expect(after.get('status')).toBe('confirmed');
    expect(after.getAll('f')).toEqual(['createdBy:me']);
    expect(after.get('page')).toBeNull();
    expect(after.get('q')).toBe('tan');
    expect(result.current.f.filters).toEqual([{ field: 'createdBy', op: 'me', value: '' }]);

    act(() => result.current.f.clear());
    const cleared = new URLSearchParams(result.current.loc.search);
    expect(cleared.getAll('f')).toEqual([]);
    expect(cleared.get('status')).toBeNull();
    expect(cleared.get('q')).toBe('tan');
  });
});

describe('the list reads send the filters', () => {
  test('useMfgSalesOrdersPaged puts each row on the wire and in the cache key', async () => {
    mockedFetch.mockResolvedValue({ salesOrders: [], total: 0 });
    renderHook(() => useMfgSalesOrdersPaged({
      page: 0, pageSize: 50, status: 'confirmed', filters: [{ field: 'balance', op: 'positive', value: '' }],
    }), { wrapper: wrap('/') });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    const url = String(mockedFetch.mock.calls[0][0]);
    expect(new URLSearchParams(url.split('?')[1]).getAll('f')).toEqual(['balance:positive']);
  });

  test('the Apply preview asks for one row and reads the total', async () => {
    mockedFetch.mockResolvedValue({ salesOrders: [], total: 12 });
    const { result } = renderHook(() => useSoListCountPreview({
      status: 'confirmed', q: '', filters: [{ field: 'createdBy', op: 'me', value: '' }], enabled: true, debounceMs: 0,
    }), { wrapper: wrap('/') });
    await waitFor(() => expect(result.current.count).toBe(12));
    const url = String(mockedFetch.mock.calls[0][0]);
    const p = new URLSearchParams(url.split('?')[1]);
    expect(p.get('pageSize')).toBe('1');
    expect(p.get('status')).toBe('CONFIRMED');
    expect(p.getAll('f')).toEqual(['createdBy:me']);
  });
});
