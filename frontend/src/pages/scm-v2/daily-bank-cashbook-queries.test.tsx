// The Daily Bank cash book hooks (owner 2026-11-23): each one's contract is the
// URL + verb + body it sends, and every write refreshes the day and the
// cash-book board — never the original board, which does not read them — so that
// is what these tests pin. authed-fetch is mocked at the module seam (the
// accounting-phase1-queries.test.tsx pattern).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import {
  useAddCashbookReceipt, useDailyBankCashbook, useDailyBankCashbookBoard, useDeleteCashbookReceipt, useEditCashbookReceipt,
  useRemoveCashbookStart, useSaveCashbookDay, useSaveCashbookStart,
} from './daily-bank-cashbook-queries';

const mockedFetch = vi.mocked(authedFetch);
let qc: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

beforeEach(() => {
  mockedFetch.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('Daily Bank cash book hooks — the wire contract', () => {
  test('the day reads GET /accounting/daily-bank/cashbook?date=', async () => {
    mockedFetch.mockResolvedValueOnce({ date: '2026-11-25', today: '2026-11-25', canWrite: true, accounts: [], receipts: [], deleted: [] });
    const { result } = renderHook(() => useDailyBankCashbook('2026-11-25'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/daily-bank/cashbook?date=2026-11-25');
  });

  test('the cash-book board reads GET /accounting/daily-bank/cashbook/board?date=', async () => {
    mockedFetch.mockResolvedValueOnce({ date: '2026-11-25', blocks: [], book: 'cashbook', notStarted: [] });
    const { result } = renderHook(() => useDailyBankCashbookBoard('2026-11-25'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/accounting/daily-bank/cashbook/board?date=2026-11-25');
  });

  test('each write sends its verb, path and body, and refreshes the day and the cash-book board', async () => {
    const refreshed = vi.spyOn(qc, 'invalidateQueries');
    /* Each write through its own hook, with its own typed arguments. */
    const send = {
      saveStart: () => renderHook(() => useSaveCashbookStart(), { wrapper }).result.current
        .mutateAsync({ accountCode: '310-0010', startDate: '2026-11-24', balanceSen: -250_000, note: null }),
      removeStart: () => renderHook(() => useRemoveCashbookStart(), { wrapper }).result.current
        .mutateAsync({ accountCode: '310-0010' }),
      addReceipt: () => renderHook(() => useAddCashbookReceipt(), { wrapper }).result.current
        .mutateAsync({ accountCode: '310-0010', date: '2026-11-25', amountSen: 300_000, note: 'Hookka deposit' }),
      editReceipt: () => renderHook(() => useEditCashbookReceipt(), { wrapper }).result.current
        .mutateAsync({ id: 'r 1', accountCode: '310-0010', date: '2026-11-25', amountSen: 1, note: 'x' }),
      deleteReceipt: () => renderHook(() => useDeleteCashbookReceipt(), { wrapper }).result.current
        .mutateAsync({ id: 'r1' }),
      saveDay: () => renderHook(() => useSaveCashbookDay(), { wrapper }).result.current
        .mutateAsync({ date: '2026-11-25', cells: [{ accountCode: '310-0010', method: 'card:GHL', amountSen: 903_150 }] }),
    };
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [send.saveStart, '/accounting/daily-bank/starts/310-0010', 'PUT', { startDate: '2026-11-24', balanceSen: -250_000, note: null }],
      [send.removeStart, '/accounting/daily-bank/starts/310-0010', 'DELETE', undefined],
      [send.addReceipt, '/accounting/daily-bank/receipts', 'POST', { accountCode: '310-0010', date: '2026-11-25', amountSen: 300_000, note: 'Hookka deposit' }],
      [send.editReceipt, '/accounting/daily-bank/receipts/r%201', 'PATCH', { accountCode: '310-0010', date: '2026-11-25', amountSen: 1, note: 'x' }],
      [send.deleteReceipt, '/accounting/daily-bank/receipts/r1', 'DELETE', undefined],
      [send.saveDay, '/accounting/daily-bank/receipts/day', 'PUT', { date: '2026-11-25', cells: [{ accountCode: '310-0010', method: 'card:GHL', amountSen: 903_150 }] }],
    ];
    for (const [run, path, method, body] of cases) {
      mockedFetch.mockReset();
      refreshed.mockClear();
      mockedFetch.mockResolvedValueOnce({ ok: true });
      await run();
      const [sentPath, init] = mockedFetch.mock.calls[0]!;
      expect([sentPath, init?.method], path).toEqual([path, method]);
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body)), path).toEqual(body);
      expect(refreshed.mock.calls.map(([f]) => (f as { queryKey: unknown[] }).queryKey), path).toEqual([['daily-bank-cashbook'], ['daily-bank-cashbook-board']]);
    }
  });
});
