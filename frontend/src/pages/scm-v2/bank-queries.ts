// Bank statement reconciliation — the hooks behind the layer-4 screen
// (accounting phase 4). Transport only, like settlement-queries: every rule
// lives on the server, so the page cannot drift from what actually posts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../lib/retryPolicy';

/** One bank account of this company that can take a statement. */
export type BankAccountSetup = {
  account_code: string;
  bank_code: string;
  account_no: string | null;
  statement_format: string;
  is_active: boolean;
  /** Enough of a column map to read anything at all. */
  ready: boolean;
};

export type BankStatement = {
  id: number;
  account_code: string;
  file_name: string;
  period_from: string | null;
  period_to: string | null;
  line_count: number;
  skipped_lines: number;
  in_sen: number;
  out_sen: number;
  opening_balance_sen: number | null;
  closing_balance_sen: number | null;
  status: string;
  uploaded_by: string | null;
  created_at: string;
  /** Derived on the server, never stored: how much is still undecided. */
  open_count?: number;
  open_sen?: number;
  open_payout_count?: number;
};

/** What the matcher made of one movement. */
export type BankLineKind = 'PAYOUT' | 'PAYOUT_SPLIT' | 'PAYOUT_UNSURE' | 'PAYOUT_NO_BATCH' | 'DUPLICATE' | 'OTHER';

export type BankCandidate = {
  id: number;
  acquirerCode: string;
  fileName?: string;
  periodFrom: string;
  periodTo: string;
  payableSen: number;
  outstandingSen: number;
};

export type BankLine = {
  id: number;
  line_no: number;
  booked_on: string;
  description: string;
  reference: string | null;
  /** Signed: positive is money in. */
  amount_sen: number;
  /** What the bank took back out of a credit it split. 0 otherwise. */
  charge_sen: number;
  kind: BankLineKind;
  acquirer_code: string | null;
  trading_date: string | null;
  merchant_no: string | null;
  /** Which merchant statement the matcher decided this settles. A suggestion —
      a person still confirms it — but the RIGHT suggestion, not the first
      candidate of that acquirer. */
  matched_batch_id: number | null;
  /** When SEVERAL statements add up to it: what each one takes. Public Bank
      pays three trading days with one advice, so this is ordinary. */
  split: Array<{ batchId: number; amountSen: number }> | null;
  state: 'OPEN' | 'POSTED' | 'IGNORED';
  posted_je_no: string | null;
  note: string | null;
  matches: Array<{ je_no: string; amount_sen: number; match_reason: string | null }>;
  candidates: BankCandidate[];
};

export type Reconciliation = {
  periodFrom: string;
  periodTo: string;
  openingStatementSen: number | null;
  openingLedgerSen: number;
  broughtForwardSen: number | null;
  movementsStatementSen: number;
  movementsLedgerSen: number;
  closingStatementSen: number | null;
  closingLedgerSen: number;
  differenceSen: number | null;
  bankNotInBooks: { count: number; sen: number };
  booksNotOnBank: { count: number; sen: number };
  unmatchedJeNos: string[];
  consistent: boolean;
  inconsistency: string | null;
  reconciled: boolean;
};

export type LedgerEntry = {
  jeNo: string;
  entryDate: string;
  sourceType: string | null;
  sourceDocNo: string | null;
  debitSen: number;
  creditSen: number;
};

export const useBankSetup = () => useQuery({
  queryKey: ['bank-setup'],
  queryFn: () => authedFetch<{ accounts: BankAccountSetup[]; recognises: string[] }>('/accounting/bank/setup'),
  staleTime: 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useBankStatements = () => useQuery({
  queryKey: ['bank-statements'],
  queryFn: () => authedFetch<{ statements: BankStatement[] }>('/accounting/bank/statements'),
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useBankStatement = (id: number | null) => useQuery({
  queryKey: ['bank-statement', id],
  queryFn: () => authedFetch<{
    statement: BankStatement;
    reconciliation: Reconciliation;
    lines: BankLine[];
    unmatchedEntries: LedgerEntry[];
  }>(`/accounting/bank/statements/${id}`),
  enabled: id != null,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* A bank movement changes the LEDGER, so everything downstream of the ledger is
   stale after one — the settlement side included, since booking a credit here
   writes a receipt there. */
const invalidateAfterBankPosting = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['bank-statement'] });
  void qc.invalidateQueries({ queryKey: ['bank-statements'] });
  void qc.invalidateQueries({ queryKey: ['settlement-batch'] });
  void qc.invalidateQueries({ queryKey: ['settlement-batches'] });
  void qc.invalidateQueries({ queryKey: ['settlement-in-transit'] });
  void qc.invalidateQueries({ queryKey: ['account-balances'] });
  void qc.invalidateQueries({ queryKey: ['control-check'] });
  void qc.invalidateQueries({ queryKey: ['daily-bank'] });
};

export const useUploadBankStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { accountCode: string; fileName: string; content: string; statementMonth?: string | null }) =>
      authedFetch<{
        ok: boolean; statementId: number; lines: number; joinedPairs: number; skippedLines: number;
        /** Movements this account had already recorded from an earlier upload —
            settled on arrival, nothing left to press. */
        alreadyRecorded: number;
        periodFrom: string; periodTo: string; inSen: number; outSen: number;
        openingBalanceSen: number | null; closingBalanceSen: number | null;
        kinds: Record<string, number>;
      }>('/accounting/bank/statements', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bank-statements'] }); },
    /* No writeFailedAs: a refused statement says WHY, and the page shows the
       server's own sentence verbatim (§2.14). */
  });
};

/** "This credit paid that merchant statement." Posts through layer 3. */
export const useBookBankReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, allocations }: {
      lineId: number;
      /** One entry for the ordinary payout, several when one credit pays
          several statements. The shares must add up to the credit. */
      allocations: Array<{ batchId: number; amountSen: number }>;
    }) =>
      authedFetch<{ ok: boolean; status: string; jeNo?: string; results: Array<{ batchId: number; jeNo: string | null; outstandingSen: number }> }>(
        `/accounting/bank/lines/${lineId}/receipt`, { method: 'POST', body: JSON.stringify({ allocations }) },
      ),
    onSuccess: () => invalidateAfterBankPosting(qc),
  });
};

/** "This movement is that journal entry." */
export const useMatchBankLine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, jeNo }: { lineId: number; jeNo: string }) =>
      authedFetch<{ ok: boolean; status: string; jeNo: string }>(
        `/accounting/bank/lines/${lineId}/match`, { method: 'POST', body: JSON.stringify({ jeNo }) },
      ),
    onSuccess: () => invalidateAfterBankPosting(qc),
  });
};

export const useIgnoreBankLine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, note }: { lineId: number; note: string }) =>
      authedFetch<{ ok: boolean; status: string }>(
        `/accounting/bank/lines/${lineId}/ignore`, { method: 'POST', body: JSON.stringify({ note }) },
      ),
    onSuccess: () => invalidateAfterBankPosting(qc),
  });
};

export const useUndoBankLine = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lineId: number) =>
      authedFetch<{ ok: boolean; status: string }>(
        `/accounting/bank/lines/${lineId}/undo`, { method: 'POST', body: '{}' },
      ),
    onSuccess: () => invalidateAfterBankPosting(qc),
    onError: writeFailedAs('Movement not put back'),
  });
};
