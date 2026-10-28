// The General Ledger hook's wire contract (docs/bugs/0923): the pair is asked
// for with showReversed=1 and never otherwise, and a row's side of a reversal
// is read off the flags scm.v_gl_entries carries. authed-fetch is mocked at the
// module seam (the accounting-phase1-queries.test.tsx pattern).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('./mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from './authed-fetch';
import { reversalSideOf, useGlEntries } from './accounting-queries';

const mockedFetch = vi.mocked(authedFetch);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => { mockedFetch.mockReset(); });

describe('useGlEntries — the wire contract', () => {
  test('without the tick, the stream is read plain — the server leaves the pair out', async () => {
    mockedFetch.mockResolvedValueOnce({ glEntries: [] });
    const { result } = renderHook(() => useGlEntries({ accountCode: '310-0010', showReversed: false }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/gl?accountCode=310-0010');
  });

  test('ticked, showReversed=1 rides along with the other filters', async () => {
    mockedFetch.mockResolvedValueOnce({ glEntries: [] });
    const { result } = renderHook(() => useGlEntries({ from: '2026-09-01', to: '2026-09-30', showReversed: true }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/gl?from=2026-09-01&to=2026-09-30&showReversed=1');
  });
});

describe('reversalSideOf — which side of a reversal a row is on', () => {
  test('the original carries reversed; the contra carries only the link back; the books carry neither', () => {
    expect(reversalSideOf({ reversed: true, reversed_by_je: 'je-contra' })).toBe('reversed');
    expect(reversalSideOf({ reversed: false, reversed_by_je: 'je-original' })).toBe('contra');
    expect(reversalSideOf({ reversed: false, reversed_by_je: null })).toBe('');
    expect(reversalSideOf({})).toBe('');
  });
});
