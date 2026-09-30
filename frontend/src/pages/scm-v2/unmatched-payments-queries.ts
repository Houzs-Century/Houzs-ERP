// The list behind "Payments not matched yet" (owner 2026-09-30: 我有没有一个表
// 是显示全部还没 match 的). Every rule lives on the server
// (backend acc/unmatched-payments); this is transport only.

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { retryUnlessClientError } from '../../lib/retryPolicy';

/** Where an unmatched payment is stuck. */
export type UnmatchedState =
  | 'CARD_NOT_REPORTED'
  | 'CARD_TO_CONFIRM'
  | 'CARD_NO_MERCHANT'
  | 'TRANSFER_NOT_BOOKED'
  | 'TRANSFER_NOT_MATCHED'
  | 'TRANSFER_NO_STATEMENT';

export type UnmatchedPayment = {
  source: 'SOPAY' | 'SIPAY';
  paymentId: string;
  docNo: string;
  customerName: string | null;
  salespersonName: string | null;
  paidOn: string;
  kind: 'card' | 'transfer';
  /** card: the bank it was keyed with (null = none, 未标); transfer: its sub-type. */
  channel: string | null;
  amountSen: number;
  reference: string | null;
  ageDays: number;
  state: UnmatchedState;
  /** transfer: the money account its entry debits, and the last day that
      account's uploaded statements reach (null = none uploaded). */
  bankAccountCode: string | null;
  statementUpTo: string | null;
};

export type UnmatchedPayments = { from: string; to: string; rows: UnmatchedPayment[] };

/** `enabled` false while the dates cannot make a window (From after To). */
export const useUnmatchedPayments = (from: string, to: string, enabled = true) => useQuery({
  queryKey: ['unmatched-payments', from, to],
  queryFn: () => authedFetch<UnmatchedPayments>(
    `/accounting/unmatched-payments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  ),
  enabled,
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
