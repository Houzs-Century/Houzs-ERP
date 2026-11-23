// The Daily Bank cash book hooks (owner 2026-11-23): each one's contract is the
// URL + verb + body it sends, and every write refreshes the day, the board and
// the To do — so that is what these tests pin. authed-fetch is mocked at the
// module seam (the accounting-phase1-queries.test.tsx pattern).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: vi.fn() }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailedAs: () => () => {} }));

import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import {
  useAddCashbookReceipt, useDailyBankCashbook, useDeleteCashbookReceipt, useEditCashbookReceipt,
  useRemoveCashbookStart, useSaveCashbookStart,
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

  test('each write sends its verb, path and body, and refreshes the day, the board and the To do', async () => {
    const refreshed = vi.spyOn(qc, 'invalidateQueries');
    const cases: Array<[() => { mutateAsync: (v: never) => Promise<unknown> }, unknown, string, string, unknown]> = [
      [useSaveCashbookStart, { accountCode: '310-0010', startDate: '2026-11-24', balanceSen: -250_000, note: null },
        '/accounting/daily-bank/starts/310-0010', 'PUT', { startDate: '2026-11-24', balanceSen: -250_000, note: null }],
      [useRemoveCashbookStart, { accountCode: '310-0010' }, '/accounting/daily-bank/starts/310-0010', 'DELETE', undefined],
      [useAddCashbookReceipt, { accountCode: '310-0010', date: '2026-11-25', amountSen: 300_000, note: 'Hookka deposit' },
        '/accounting/daily-bank/receipts', 'POST', { accountCode: '310-0010', date: '2026-11-25', amountSen: 300_000, note: 'Hookka deposit' }],
      [useEditCashbookReceipt, { id: 'r 1', accountCode: '310-0010', date: '2026-11-25', amountSen: 1, note: 'x' },
        '/accounting/daily-bank/receipts/r%201', 'PATCH', { accountCode: '310-0010', date: '2026-11-25', amountSen: 1, note: 'x' }],
      [useDeleteCashbookReceipt, { id: 'r1' }, '/accounting/daily-bank/receipts/r1', 'DELETE', undefined],
    ];
    for (const [hook, vars, path, method, body] of cases) {
      mockedFetch.mockReset();
      refreshed.mockClear();
      mockedFetch.mockResolvedValueOnce({ ok: true });
      const { result } = renderHook(() => hook(), { wrapper });
      await result.current.mutateAsync(vars as never);
      const [sentPath, init] = mockedFetch.mock.calls[0]!;
      expect([sentPath, init?.method], path).toEqual([path, method]);
      expect(init?.body === undefined ? undefined : JSON.parse(String(init.body)), path).toEqual(body);
      expect(refreshed.mock.calls.map(([f]) => (f as { queryKey: unknown[] }).queryKey), path).toEqual([['daily-bank-cashbook'], ['daily-bank'], ['finance-todo']]);
    }
  });
});
