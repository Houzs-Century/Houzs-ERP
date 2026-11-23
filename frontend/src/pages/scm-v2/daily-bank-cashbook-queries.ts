// Daily Bank's cash book (owner 2026-11-23): each money account's starting
// balance and the receipts typed by hand (backend routes/accounting-daily-bank-
// cashbook.ts). Every write refreshes the day, the board and the To do's "Can
// move today", which reads the same board.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../lib/retryPolicy';

export type CashbookStartInfo = { date: string; balanceSen: number; note: string | null; setBy: string | null; setAt: string | null };
export type CashbookAccount = { accountCode: string; accountName: string; start: CashbookStartInfo | null };
export type CashbookReceiptRow = {
  id: string; accountCode: string; accountName: string; date: string; amountSen: number; note: string;
  createdBy: string | null; createdAt: string | null; updatedBy: string | null; updatedAt: string | null;
  deletedBy: string | null; deletedAt: string | null;
  /** On the board: its account's start is on or before it, and it is not deleted. */
  counted: boolean;
};
export type CashbookDay = {
  date: string; today: string; canWrite: boolean;
  accounts: CashbookAccount[]; receipts: CashbookReceiptRow[]; deleted: CashbookReceiptRow[];
};

export const useDailyBankCashbook = (date: string) => useQuery({
  queryKey: ['daily-bank-cashbook', date],
  queryFn: () => authedFetch<CashbookDay>(`/accounting/daily-bank/cashbook?date=${date}`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

function useCashbookWrite<V>(send: (v: V) => Promise<unknown>, failedTitle: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['daily-bank-cashbook'] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    },
    onError: writeFailedAs(failedTitle),
  });
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const startPath = (code: string): string => `/accounting/daily-bank/starts/${encodeURIComponent(code)}`;
const receiptPath = (id: string): string => `/accounting/daily-bank/receipts/${encodeURIComponent(id)}`;

export const useSaveCashbookStart = () => useCashbookWrite(
  (v: { accountCode: string; startDate: string; balanceSen: number; note: string | null }) =>
    authedFetch<{ ok: boolean }>(startPath(v.accountCode), json('PUT', { startDate: v.startDate, balanceSen: v.balanceSen, note: v.note })),
  'Starting balance not saved',
);

export const useRemoveCashbookStart = () => useCashbookWrite(
  (v: { accountCode: string }) => authedFetch<{ ok: boolean }>(startPath(v.accountCode), json('DELETE')),
  'Starting balance not removed',
);

export const useAddCashbookReceipt = () => useCashbookWrite(
  (v: { accountCode: string; date: string; amountSen: number; note: string }) =>
    authedFetch<{ ok: boolean; id: string }>('/accounting/daily-bank/receipts', json('POST', v)),
  'Receipt not saved',
);

export const useEditCashbookReceipt = () => useCashbookWrite(
  (v: { id: string; accountCode: string; date: string; amountSen: number; note: string }) =>
    authedFetch<{ ok: boolean }>(receiptPath(v.id), json('PATCH', { accountCode: v.accountCode, date: v.date, amountSen: v.amountSen, note: v.note })),
  'Receipt not changed',
);

export const useDeleteCashbookReceipt = () => useCashbookWrite(
  (v: { id: string }) => authedFetch<{ ok: boolean }>(receiptPath(v.id), json('DELETE')),
  'Receipt not deleted',
);
