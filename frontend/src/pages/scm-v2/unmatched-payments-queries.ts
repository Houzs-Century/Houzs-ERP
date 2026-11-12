// The lists behind "Payments not matched yet" (owner 2026-09-30: 我有没有一个表
// 是显示全部还没 match 的; 2026-11-10: the bank's money with no entry too). Every
// rule lives on the server (backend acc/unmatched-payments,
// acc/unmatched-bank-lines); this is transport only. The merchant report lines
// are Merchant Recon's own reports (settlement-queries).

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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

/** The merchant report a card payment's line is on (owner 2026-11-10). */
export type UnmatchedReport = {
  batchId: number;
  fileName: string | null;
  acquirerCode: string;
  /** Its lines nobody has confirmed or set aside. */
  waitingLines: number;
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
  /** transfer: its entry's number — the entry Bank money in may offer a bank line to. */
  jeNo?: string | null;
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

/* ── Previous records (owner 2026-11-11: 我检查确定后，就直接说这个是之前record，
   我哪里都不会take-in) — a salesperson's payment record marked as the previous
   system's, shown on no list and offered to no merchant or bank line. The rule
   is the server's (backend acc/previous-payments). */

/** A payment, as the server names it. */
export type PaymentRef = { source: 'SOPAY' | 'SIPAY'; id: string };

/** One marked payment, as the Previous records list shows it. */
export type PreviousPayment = PaymentRef & {
  docNo: string | null;
  customer: string | null;
  paidOn: string;
  method: string;
  /** card: the bank it was keyed with; transfer: its sub-type. */
  channel: string | null;
  amountSen: number;
  reference: string | null;
  markedBy: string | null;
  markedAt: string;
};

/** One the server would not mark, and why — its sentence is the screen's. */
export type PreviousRefusal = PaymentRef & { docNo: string | null; reason: 'not_found' | 'merchant_line' | 'in_the_books'; message: string };

export const usePreviousPayments = (enabled = true) => useQuery({
  queryKey: ['previous-payments'],
  queryFn: () => authedFetch<{ rows: PreviousPayment[] }>('/accounting/previous-payments'),
  enabled,
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** Every list a mark changes: the two unmatched lists, Merchant Recon's watch list, the Cash Flow. */
const refreshAfterMark = (qc: QueryClient) => {
  for (const key of ['previous-payments', 'unmatched-payments', 'settlement-watchlist']) void qc.invalidateQueries({ queryKey: [key] });
  void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('report-rp') });
};

export const useMarkPrevious = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payments: PaymentRef[]) => authedFetch<{ ok: boolean; marked: number; refused: PreviousRefusal[] }>(
      '/accounting/previous-payments', { method: 'POST', body: JSON.stringify({ payments }) },
    ),
    onSuccess: () => refreshAfterMark(qc),
  });
};

export const useUndoPrevious = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payments: PaymentRef[]) => authedFetch<{ ok: boolean; undone: number }>(
      '/accounting/previous-payments/undo', { method: 'POST', body: JSON.stringify({ payments }) },
    ),
    onSuccess: () => refreshAfterMark(qc),
  });
};
