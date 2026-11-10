// The lists behind "Payments not matched yet" (owner 2026-09-30: 我有没有一个表
// 是显示全部还没 match 的; 2026-11-10: the bank's money with no entry too). Every
// rule lives on the server (backend acc/unmatched-payments,
// acc/unmatched-bank-lines); this is transport only. The merchant report lines
// are Merchant Recon's own reports (settlement-queries).

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { retryUnlessClientError } from '../../lib/retryPolicy';

/** Where an unmatched payment is stuck. */
export type UnmatchedState =
  | 'CARD_NOT_REPORTED'
  | 'CARD_TO_CONFIRM'
  /** The merchant matched it; its report's money is not in a bank yet. */
  | 'CARD_NOT_IN_BANK'
  | 'CARD_NO_MERCHANT'
  | 'TRANSFER_NOT_BOOKED'
  | 'TRANSFER_NOT_MATCHED'
  | 'TRANSFER_NO_STATEMENT';

/** The merchant report a card payment's line is on (owner 2026-11-10). */
export type UnmatchedReport = {
  batchId: number;
  fileName: string | null;
  acquirerCode: string;
  /** Its lines nobody has confirmed or set aside — while any, no bank line is offered it. */
  waitingLines: number;
  /** The share (0..1) of its money booked bank credits hold. */
  bankShare: number;
};

export type UnmatchedPayment = {
  source: 'SOPAY' | 'SIPAY';
  paymentId: string;
  docNo: string;
  customerName: string | null;
  salespersonName: string | null;
  /** Who took the money — the payment's own collected_by; null when nobody was recorded. */
  collectedByName: string | null;
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
  /** card: the report its line is on, when a line claims it. */
  report?: UnmatchedReport | null;
};

export type UnmatchedPayments = { from: string; to: string; rows: UnmatchedPayment[] };

/** What an OPEN money-in bank line is, as Bank Recon decides it today. */
export type BankLineWhat = 'CARD' | 'QR' | 'TRANSFER';

export type UnmatchedBankLine = {
  lineId: number;
  statementId: number;
  accountCode: string;
  bankName: string | null;
  bookedOn: string;
  /** YYYY-MM — the month Bank statements opens it in. */
  month: string;
  description: string;
  reference: string | null;
  amountSen: number;
  what: BankLineWhat;
  kind: string;
  acquirerCode: string | null;
  /** The decider's own sentence for it (card payout, QR money). */
  note: string | null;
  /** TRANSFER: same-amount entries within the window no bank line holds, and the first few. */
  entryCount: number;
  entries: Array<{ jeNo: string; entryDate: string; doc: string | null; who: string | null; daysApart: number }>;
  ageDays: number;
};

export type UnmatchedBankLines = { from: string; to: string; rows: UnmatchedBankLine[] };

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

/** The bank's money-in lines nothing in the books is matched to (owner 2026-11-10). */
export const useUnmatchedBankLines = (from: string, to: string, enabled = true) => useQuery({
  queryKey: ['unmatched-bank-lines', from, to],
  queryFn: () => authedFetch<UnmatchedBankLines>(
    `/accounting/unmatched-bank-lines?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  ),
  enabled,
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});
