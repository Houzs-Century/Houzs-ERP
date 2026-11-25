// Daily Bank's cash book, a second Daily Bank beside the original (owner
// 2026-11-23): its board, each money account's starting balance and the
// receipts typed by hand (backend routes/accounting-daily-bank-cashbook.ts).
// Every write refreshes the day and the cash-book board; the original board
// never reads them.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../lib/retryPolicy';
import type { DailyBankBoard } from './accounting-phase1-queries';

export type CashbookStartInfo = { date: string; balanceSen: number; note: string | null; setBy: string | null; setAt: string | null };
export type CashbookAccount = { accountCode: string; accountName: string; start: CashbookStartInfo | null };
export type CashbookReceiptRow = {
  id: string; accountCode: string; accountName: string; date: string; amountSen: number; note: string;
  createdBy: string | null; createdAt: string | null; updatedBy: string | null; updatedAt: string | null;
  deletedBy: string | null; deletedAt: string | null;
  /** On the board: its account's start is on or before it, and it is not deleted. */
  counted: boolean;
  /** The grid's column it was keyed in (online, cash, cheque, card:<code>); null = typed with a note. */
  method: string | null;
};
/** A way money comes in: one column of the day's grid. */
export type CashbookMethod = { key: string; label: string };
export type CashbookDay = {
  date: string; today: string; canWrite: boolean;
  accounts: CashbookAccount[]; receipts: CashbookReceiptRow[]; deleted: CashbookReceiptRow[];
  /** The grid's columns: Online, Cash, Cheque, then the company's active card terminals. */
  methods: CashbookMethod[];
};

/** The cash-book board: the same shape as the original Daily Bank's, its banks
    read from their starts, the receipts typed and the approved vouchers. */
export const useDailyBankCashbookBoard = (date: string) => useQuery({
  queryKey: ['daily-bank-cashbook-board', date],
  queryFn: () => authedFetch<DailyBankBoard>(`/accounting/daily-bank/cashbook/board?date=${date}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

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
      void qc.invalidateQueries({ queryKey: ['daily-bank-cashbook-board'] });
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

/** The day's grid (owner 2026-11-23): the cells that changed, each bank × method's total; 0 clears one. */
export const useSaveCashbookDay = () => useCashbookWrite(
  (v: { date: string; cells: Array<{ accountCode: string; method: string; amountSen: number }> }) =>
    authedFetch<{ ok: boolean; created: number; updated: number; deleted: number }>('/accounting/daily-bank/receipts/day', json('PUT', v)),
  'Income not saved',
);

export const useDeleteCashbookReceipt = () => useCashbookWrite(
  (v: { id: string }) => authedFetch<{ ok: boolean }>(receiptPath(v.id), json('DELETE')),
  'Receipt not deleted',
);

/* An approved voucher ticked as already in its bank's starting balance (owner
   2026-11-25: 要，加勾选): the cash book lists it and does not take it off; untick
   and it comes off again. */
const skipPath = (pvId: string): string => `/accounting/daily-bank/skips/${encodeURIComponent(pvId)}`;

export const useSkipCashbookVoucher = () => useCashbookWrite(
  (v: { pvId: string }) => authedFetch<{ ok: boolean }>(skipPath(v.pvId), json('PUT')),
  'Voucher not ticked',
);

export const useUnskipCashbookVoucher = () => useCashbookWrite(
  (v: { pvId: string }) => authedFetch<{ ok: boolean }>(skipPath(v.pvId), json('DELETE')),
  'Voucher not unticked',
);
