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

/** A posted ledger entry this movement could BE — the answer for everything on
    a statement that is not card money. Ranked by the server (acc/bank-match):
    the amount agrees to the sen and in the same direction, the entry is inside
    a few days, and nothing else has claimed it. */
export type BankEntryCandidate = {
  jeNo: string;
  entryDate: string;
  sourceType: string | null;
  sourceDocNo: string | null;
  debitSen: number;
  creditSen: number;
  /** Signed the way the statement signs it: positive is money in. */
  amountSen: number;
  daysApart: number;
  /** Who was paid / who paid, off the entry. */
  partyName?: string | null;
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
  entryCandidates: BankEntryCandidate[];
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
  /** Earlier periods' entries still not on any statement — what the
      brought-forward is made of. */
  carried: { count: number; sen: number };
  carriedJeNos: string[];
  clearedFromBeforeSen?: number;
  broughtForwardExplained: boolean | null;
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
  /** Who was paid / who paid (owner 2026-09-11: 例如 pay to who). */
  partyName?: string | null;
  notes?: string | null;
  /** Posted before this period and still not on any statement — carried
      (owner: 之前 in book 还没有 recon 的也要带下来，因为可能下个月才过钱). */
  carried?: boolean;
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
  /* The month is the same movements counted a second way, so a decision on one
     of them is a decision about its month too — and the month view is where
     the owner works. Missing these leaves a line settled on one screen and
     still waiting on the other. */
  void qc.invalidateQueries({ queryKey: ['bank-month'] });
  void qc.invalidateQueries({ queryKey: ['bank-months'] });
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

/* ── Recognition rules maintenance (2026-09-02) — the owner's screwdriver for
   "this credit is PBB's payout". Server-validated: a regex is compiled at
   write time and refused with the engine's sentence, so a broken one can
   never silently un-recognise an acquirer's money. */
export type BankRule = {
  id: number; acquirer_code: string; pattern: string;
  match_field: 'description' | 'reference' | 'both';
  trading_date_pattern: string | null; merchant_pattern: string | null;
  sort_order: number; is_active: boolean;
};
/* ── Which accounts take a statement, and how each file reads (2026-09-08) ─── */

/** One heading, or the several a bank has used for the same column. */
export type BankHeading = string | string[];
export type BankColumnMap = Partial<Record<'date' | 'description' | 'reference' | 'amount' | 'debit' | 'credit' | 'indicator' | 'balance' | 'valueDate', BankHeading>>;
export type BankConfig = {
  id: number;
  account_code: string;
  bank_code: string;
  account_no: string | null;
  statement_format: string;
  delimiter: string | null;
  amount_format: 'decimal' | 'integer-sen';
  credit_indicator: string;
  column_map: BankColumnMap;
  is_active: boolean;
};

export const useBankConfigs = () => useQuery({
  queryKey: ['bank-config'],
  queryFn: () => authedFetch<{ configs: BankConfig[]; defaultHeadings: Record<string, string[]> }>('/accounting/bank/config'),
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSaveBankConfig = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      accountCode: string; bankCode: string; accountNo?: string; statementFormat: string; delimiter?: string;
      amountFormat: string; creditIndicator?: string; isActive?: boolean; columnMap: Record<string, string | string[]>;
    }) => authedFetch<{ ok: boolean; config: BankConfig }>('/accounting/bank/config', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bank-config'] });
      void qc.invalidateQueries({ queryKey: ['bank-setup'] });
    },
  });
};

export const useBankRules = () => useQuery({
  queryKey: ['bank-rules'],
  queryFn: () => authedFetch<{ rules: BankRule[] }>(`/accounting/bank/rules`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

export const useSaveBankRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Partial<{
      pattern: string; matchField: string; tradingDatePattern: string | null;
      merchantPattern: string | null; sortOrder: number; isActive: boolean;
    }>) => authedFetch<{ ok: boolean; rule: BankRule }>(
      `/accounting/bank/rules/${id}`, { method: 'PATCH', body: JSON.stringify(patch) },
    ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bank-rules'] }); },
  });
};

export const useCreateBankRule = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { acquirerCode: string; pattern: string; matchField?: string; sortOrder?: number }) =>
      authedFetch<{ ok: boolean; rule: BankRule }>(
        `/accounting/bank/rules`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bank-rules'] }); },
  });
};

/* ── A MONTH of one account, however many files fed it ─────────────────────
   Owner, 2026-09-08: 每天我上传bank statement 和 merchant report 测试，但是有办法
   选这个是几月的？因为我发现好像没有. Layer 4 reconciled one FILE, which is a
   file a day for Hong Leong's any-day export — thirty answers and none of them
   the answer to "did September agree". The server assembles the month
   (acc/bank-month) and judges it with the same reconciliation; these are
   transport only, like everything else in this file. */

export type BankMonth = {
  accountCode: string;
  month: string;
  statementCount: number;
  lineCount: number;
  openCount: number;
  openSen: number;
  openPayoutCount: number;
  inSen: number;
  outSen: number;
  periodFrom: string | null;
  periodTo: string | null;
  openingBalanceSen: number | null;
  closingBalanceSen: number | null;
  /** Opening known, closing known, and no break between the files. */
  complete: boolean;
  gapCount: number;
  /** Null means open. Named rather than a bare flag: an operator who finds a
      month he cannot work needs the name, not a padlock. */
  locked: { lockedBy: string | null; lockedAt: string } | null;
};

/** Two files that should have met and did not — a day nobody uploaded. */
export type BankChainBreak = {
  beforeId: number; beforeFile: string; beforeTo: string; beforeClosingSen: number;
  afterId: number; afterFile: string; afterFrom: string; afterOpeningSen: number;
  gapSen: number;
};

export type BankMonthAssembly = {
  month: string;
  monthFrom: string;
  monthTo: string;
  periodFrom: string;
  periodTo: string;
  statementOpeningSen: number | null;
  openingFrom: { statementId: number; fileName: string; on: string } | null;
  statementClosingSen: number | null;
  closingFrom: { statementId: number; fileName: string; on: string } | null;
  spanningIds: number[];
  breaks: BankChainBreak[];
  gaps: string[];
  complete: boolean;
};

export const useBankMonths = () => useQuery({
  queryKey: ['bank-months'],
  queryFn: () => authedFetch<{ months: BankMonth[] }>('/accounting/bank/months'),
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useBankMonth = (accountCode: string | null, month: string | null) => useQuery({
  queryKey: ['bank-month', accountCode, month],
  queryFn: () => authedFetch<{
    accountCode: string;
    month: string;
    assembly: BankMonthAssembly;
    reconciliation: Reconciliation;
    lock: BankMonthLock | null;
    statements: Array<BankStatement & { spanning: boolean }>;
    lines: Array<BankLine & { file_name: string | null }>;
    unmatchedEntries: LedgerEntry[];
  }>(`/accounting/bank/months/${encodeURIComponent(accountCode!)}/${encodeURIComponent(month!)}`),
  enabled: accountCode != null && month != null,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Closing a reconciled month ────────────────────────────────────────────
   Owner, 2026-09-08: 还有lock 起来不可以随便碰. Every rule about whether a month
   MAY be closed lives on the server (acc/bank-lock.ts) — these are transport,
   and the refusals they surface are the server's own sentences. */

export type BankMonthLock = {
  accountCode: string;
  month: string;
  lockedBy: string | null;
  lockedAt: string;
  lockNote: string | null;
  closingStatementSen: number | null;
  closingLedgerSen: number | null;
  differenceSen: number | null;
  statementCount: number;
  wasComplete: boolean;
};

export const useLockBankMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountCode, month, note }: { accountCode: string; month: string; note?: string | null }) =>
      authedFetch<{ ok: boolean; lock: BankMonthLock; reasonRecorded: boolean }>(
        `/accounting/bank/months/${encodeURIComponent(accountCode)}/${encodeURIComponent(month)}/lock`,
        { method: 'POST', body: JSON.stringify({ note: note ?? null }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bank-month'] });
      void qc.invalidateQueries({ queryKey: ['bank-months'] });
    },
  });
};

export const useUnlockBankMonth = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountCode, month, note }: { accountCode: string; month: string; note: string }) =>
      authedFetch<{ ok: boolean; lock: BankMonthLock }>(
        `/accounting/bank/months/${encodeURIComponent(accountCode)}/${encodeURIComponent(month)}/unlock`,
        { method: 'POST', body: JSON.stringify({ note }) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bank-month'] });
      void qc.invalidateQueries({ queryKey: ['bank-months'] });
    },
  });
};
