// The bank hooks' contract is the URL + verb + body each one sends — pinned
// the same way settlement-queries.test.tsx does, with authed-fetch mocked at
// the module seam. Until this file existed, bank-queries was the one module
// on this screen no test EXECUTED (BankStatementTab.test.tsx mocks it), which
// is exactly the shape the coverage ratchet counts: a transport layer whose
// paths nothing would catch drifting.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import {
  useBankSetup, useBankStatements, useBankStatement, useUploadBankStatement,
  useBookBankReceipt, useMatchBankLine, useIgnoreBankLine, useUndoBankLine,
} from './bank-queries';

const mockedFetch = vi.mocked(authedFetch);

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => { mockedFetch.mockReset(); });

describe('the reads', () => {
  test('useBankSetup reads GET /accounting/bank/setup', async () => {
    mockedFetch.mockResolvedValueOnce({ accounts: [], recognises: [] });
    const { result } = renderHook(() => useBankSetup(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/bank/setup');
  });

  test('useBankStatements and useBankStatement read the list and one statement', async () => {
    mockedFetch.mockResolvedValueOnce({ statements: [] });
    const list = renderHook(() => useBankStatements(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/bank/statements');

    mockedFetch.mockResolvedValueOnce({ statement: {}, reconciliation: {}, lines: [], unmatchedEntries: [] });
    const one = renderHook(() => useBankStatement(5), { wrapper });
    await waitFor(() => expect(one.result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/bank/statements/5');
  });

  test('useBankStatement stays idle until there is a statement to read', () => {
    const { result } = renderHook(() => useBankStatement(null), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe('the writes', () => {
  test('useUploadBankStatement posts the file to the statements endpoint', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, statementId: 3, lines: 9 });
    const { result } = renderHook(() => useUploadBankStatement(), { wrapper });
    result.current.mutate({ accountCode: '330-0000', fileName: 'aug.csv', content: 'a|b' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/bank/statements');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({ accountCode: '330-0000', fileName: 'aug.csv' });
  });

  test('useBookBankReceipt sends the allocations, with the line in the path', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 'posted', results: [] });
    const { result } = renderHook(() => useBookBankReceipt(), { wrapper });
    /* ONE CREDIT CAN PAY SEVERAL STATEMENTS — the allocations array is the
       whole point of the shape, so it is pinned with two. */
    result.current.mutate({
      lineId: 7,
      allocations: [{ batchId: 1, amountSen: 100000 }, { batchId: 2, amountSen: 250000 }],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/accounting/bank/lines/7/receipt');
    const body = JSON.parse(String(init?.body));
    expect(body.allocations).toHaveLength(2);
    expect(body.lineId).toBeUndefined();
  });

  test('match, ignore and undo hit their own endpoints', async () => {
    mockedFetch.mockResolvedValueOnce({ ok: true, status: 'posted', jeNo: 'JE-2608-0002' });
    const match = renderHook(() => useMatchBankLine(), { wrapper });
    match.result.current.mutate({ lineId: 4, jeNo: 'JE-2608-0002' });
    await waitFor(() => expect(match.result.current.isSuccess).toBe(true));
    expect(mockedFetch.mock.calls[0]![0]).toBe('/accounting/bank/lines/4/match');
    expect(JSON.parse(String(mockedFetch.mock.calls[0]![1]?.body))).toEqual({ jeNo: 'JE-2608-0002' });

    mockedFetch.mockResolvedValueOnce({ ok: true, status: 'ignored' });
    const ignore = renderHook(() => useIgnoreBankLine(), { wrapper });
    ignore.result.current.mutate({ lineId: 4, note: 'own transfer, booked from the other side' });
    await waitFor(() => expect(ignore.result.current.isSuccess).toBe(true));
    expect(mockedFetch.mock.calls[1]![0]).toBe('/accounting/bank/lines/4/ignore');
    /* The reason travels — an ignored movement leaves the difference for ever
       and this sentence is all the next person will have. */
    expect(JSON.parse(String(mockedFetch.mock.calls[1]![1]?.body))).toEqual({ note: 'own transfer, booked from the other side' });

    mockedFetch.mockResolvedValueOnce({ ok: true, status: 'open' });
    const undo = renderHook(() => useUndoBankLine(), { wrapper });
    undo.result.current.mutate(4);
    await waitFor(() => expect(undo.result.current.isSuccess).toBe(true));
    expect(mockedFetch.mock.calls[2]![0]).toBe('/accounting/bank/lines/4/undo');
  });
});
