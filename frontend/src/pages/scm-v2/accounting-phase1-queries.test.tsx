// The phase-1 accounting hooks: each one's contract is the URL + verb + body
// it sends, so that is what these tests pin. authed-fetch is mocked at the
// module seam (the so-versioned-mutation.test.ts pattern) — no network, no
// component tree, just the hook running under a real QueryClient.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import {
  useCreateAccount,
  useUpdateAccount,
  useReverseJournalEntry,
  useControlCheck,
} from './accounting-phase1-queries';

const mockedFetch = vi.mocked(authedFetch);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => { mockedFetch.mockReset(); });

describe('accounting phase-1 hooks — the wire contract', () => {
  test('useControlCheck reads GET /accounting/control-check', async () => {
    mockedFetch.mockResolvedValueOnce({ checks: [{ role: 'AR', accountCode: '300-0000', glBalanceSen: 0, driftDocs: [], foreignLines: [], ok: true }] });
    const { result } = renderHook(() => useControlCheck(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/control-check');
    expect(result.current.data?.checks[0]).toMatchObject({ role: 'AR', ok: true });
  });

  test('useCreateAccount posts the chart row to POST /accounting/accounts', async () => {
    mockedFetch.mockResolvedValueOnce({ account: { account_code: '950-0000' } });
    const { result } = renderHook(() => useCreateAccount(), { wrapper });
    result.current.mutate({ accountCode: '950-0000', accountName: 'Marketing', accountType: 'EXPENSE', parentCode: '900-0000' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/accounts');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ accountCode: '950-0000', accountType: 'EXPENSE', parentCode: '900-0000' });
  });

  test('useUpdateAccount PATCHes the code in the path, not the body', async () => {
    mockedFetch.mockResolvedValueOnce({ account: { account_code: '905-0000' } });
    const { result } = renderHook(() => useUpdateAccount(), { wrapper });
    result.current.mutate({ code: '905-0000', accountName: 'Rent & Premises', isActive: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/accounts/905-0000');
    expect(init?.method).toBe('PATCH');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ accountName: 'Rent & Premises', isActive: true });
    expect(body.code).toBeUndefined();
  });

  test('useReverseJournalEntry posts to the entry’s reverse endpoint', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 'reversed', jeNo: 'JE-2608-0002' });
    const { result } = renderHook(() => useReverseJournalEntry(), { wrapper });
    result.current.mutate('je-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/journal-entries/je-1/reverse', { method: 'POST' });
  });
});
