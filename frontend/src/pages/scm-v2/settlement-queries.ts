// Acquirer settlement reconciliation — the hooks behind the layer-3 screen
// (accounting phase 2B; brief §3.5 layer 3). Every rule lives on the server;
// these are transport only, so the page cannot drift from what actually posts.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from '../../vendor/scm/lib/authed-fetch';
import { writeFailedAs } from '../../vendor/scm/lib/mutation-error';
import { retryUnlessClientError } from '../../lib/retryPolicy';

export type SettlementBucket = 'MATCHED' | 'NEEDS_CONFIRM' | 'UNMATCHED' | 'IGNORED';

export type AcquirerSetup = {
  code: string;
  display_name: string;
  statement_format: string | null;
  has_unique_ref: boolean | null;
  fee_method: string | null;
  date_tolerance_days: number;
  column_map: Record<string, string> | null;
  /** Hong Leong writes "16-Aug" with no year anywhere in the file, so its
      upload has to ask which month the statement covers. Nobody else does. */
  dates_have_no_year?: boolean;
  transit_account_code: string;
  fee_account_code: string;
  bank_account_code: string | null;
  is_active: boolean;
  /** Enough config to READ a statement (global — shared by every company). */
  ready: boolean;
  /** A receiving bank account is set FOR THIS COMPANY, so a payout can be
      booked. Separate from the ready flag because the same merchant pays different
      companies into different banks (owner: 例如pbb，在houzs 可能是maybank 收钱，
      但是在2990 是hong leong bank 收钱). */
  bankReady?: boolean;
  /** Carries a unique reference — the only thing that may auto-match. */
  autoMatchable: boolean;
};

/** A money account of the ACTIVE company — where a payout can land. */
export type BankAccount = { account_code: string; account_name: string };

export type SettlementCandidate = {
  source: 'SOPAY' | 'SIPAY';
  id: string;
  docNo: string;
  paidOn: string;
  amountSen: number;
  approvalCode: string | null;
  /** Who paid — on the batch-detail candidates (the matcher carries it); the
      watchlist's do not, so a reader has to ask. */
  customerName?: string | null;
  /** Which acquirer the payment was recorded as. Null on migration-era rows —
      shown as 未标 merchant so the operator knows he is claiming untagged
      money; confirming stamps the tag on. */
  merchantProvider?: string | null;
};

export type SettlementLink = {
  settlement_row_id: number;
  payment_source: string;
  payment_id: string;
  doc_no: string | null;
  amount_sen: number;
  /* The sale itself, so a reconciliation can show WHO and WHEN and not only a
     document number (owner: 显示 transaction detail 和 sales order detail). */
  paid_on?: string | null;
  customer_name?: string | null;
  approval_code?: string | null;
};

export type SettlementRow = {
  id: number;
  line_no: number;
  txn_date: string;
  ref: string | null;
  gross_sen: number;
  fee_sen: number;
  net_sen: number;
  bucket: SettlementBucket;
  match_reason: string | null;
  confirmed_at: string | null;
  posted_je_no: string | null;
  notes: string | null;
  linked: SettlementLink[];
  candidates: SettlementCandidate[];
  /** Sets of payments that add up to the line — two orders on one swipe, or
      three. The screen flattens them into "these are worth a look". */
  comboHints: string[][];
  /** What the system itself would pick — pre-ticked, still yours to confirm.
      Empty unless there is exactly ONE way to make this line amount. */
  suggested?: SettlementCandidate[];
  clue: string | null;
};

/** One credit of a payout, as the BANK shows it. */
export type SettlementReceipt = {
  id: number;
  received_on: string;
  amount_sen: number;
  bank_ref: string | null;
  note: string | null;
  je_no: string | null;
  created_by: string | null;
};

export type SettlementBatch = {
  id: number;
  acquirer_code: string;
  file_name: string;
  period_from: string | null;
  period_to: string | null;
  row_count: number;
  gross_sen: number;
  fee_sen: number;
  net_sen: number;
  /** What the statement itself says it is paying, when it says so. */
  stated_net_sen: number | null;
  /** lines net minus stated net: a charge the transactions do not explain. */
  adjustment_sen: number;
  adjustment_je_no: string | null;
  /** How far the merchant side got: lines confirmed, lines still open, and
      the two kinds of open — one you can decide, one nobody recorded. */
  confirmed_count?: number;
  open_count?: number;
  /* MATCHED and unconfirmed: already matched by reference, one button away.
     Not a decision — calling it one made an auto-matched line look wrong. */
  to_confirm_count?: number;
  to_choose_count?: number;
  no_record_count?: number;
  /** How much of the payout has landed, across however many credits it came
      in — one statement is often paid in several. */
  received_sen?: number;
  receipt_count?: number;
  outstanding_sen?: number;
  /** The day it was FULLY received; null while any of it is still out, so
      "partly in the bank" can never read as "in the bank". */
  received_on: string | null;
  /** Only on the batch DETAIL: every credit recorded against this statement. */
  receipts?: SettlementReceipt[];
  /** Only on the batch DETAIL: which bank account this payout will be booked
      to for THIS company, and whether that was configured or fallen back to. */
  receiving_bank?: { code: string; name: string | null; configured: boolean };
  status: string;
  uploaded_by: string | null;
  created_at: string;
};

export const useAcquirerSetup = () => useQuery({
  queryKey: ['settlement-setup'],
  queryFn: () => authedFetch<{ acquirers: AcquirerSetup[]; bankAccounts: BankAccount[] }>(`/accounting/settlement/setup`),
  staleTime: 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSaveAcquirerSetup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: {
      code: string;
      statementFormat?: string | null;
      hasUniqueRef?: boolean | null;
      feeMethod?: string | null;
      dateToleranceDays?: number;
      columnMap?: Record<string, string> | null;
      bankAccountCode?: string | null;
      transitAccountCode?: string;
      feeAccountCode?: string;
      isActive?: boolean;
    }) => authedFetch<{ ok: boolean }>(`/accounting/settlement/setup/${encodeURIComponent(code)}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settlement-setup'] }); },
    onError: writeFailedAs('Acquirer setup not saved'),
  });
};

/* ── Maintenance: ONE table, every company at once ──────────────────────────
   The owner's shape (2026-08-18): 我应该 overall maintenance table，左手边是
   merchant、bank，上面 header 是公司，这个公司有就 tick. So the read answers for
   every company he is granted, and the writes name the company they change —
   which the server re-checks against those same grants. */

export type MaintenanceCompany = { id: number; code: string; name: string };

/** One merchant as the matrix needs it: the shared half on the row, and what
    each company does with it keyed by company id. */
export type MaintenanceMerchant = {
  code: string;
  display_name: string;
  statement_format: string | null;
  has_unique_ref: boolean | null;
  fee_method: string | null;
  date_tolerance_days: number;
  column_map: Record<string, string> | null;
  ready: boolean;
  autoMatchable: boolean;
  /* Keyed by company id, and only for the companies the server answered for —
     so a lookup can miss, and every reader has to say what it does then. */
  byCompany: Record<string, { enabled: boolean; linked: boolean; bankAccountCode: string | null } | undefined>;
};

/** One account CODE across every company — the rows of the bank matrix. */
export type MaintenanceBank = {
  account_code: string;
  account_name: string;
  byCompany: Record<string, { inChart: boolean; enabled: boolean; usedBy: string[] } | undefined>;
};

export type MaintenanceData = {
  companies: MaintenanceCompany[];
  merchants: MaintenanceMerchant[];
  banks: MaintenanceBank[];
};

export const useSettlementMaintenance = () => useQuery({
  queryKey: ['settlement-maintenance'],
  queryFn: () => authedFetch<MaintenanceData>('/accounting/settlement/maintenance'),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

const invalidateMaintenance = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['settlement-maintenance'] });
  void qc.invalidateQueries({ queryKey: ['settlement-setup'] });
};

/** Tick a merchant on or off for one company, or point it at a bank. */
export const useSaveMaintenanceMerchant = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { companyId: number; code: string; enabled?: boolean; bankAccountCode?: string | null }) =>
      authedFetch<{ ok: boolean; created: boolean }>('/accounting/settlement/maintenance/merchant', {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateMaintenance(qc),
    onError: writeFailedAs('Merchant not saved'),
  });
};

/** Tick which banks a company actually banks with. */
export const useSaveMaintenanceBank = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { companyId: number; accountCode: string; enabled: boolean }) =>
      authedFetch<{ ok: boolean }>('/accounting/settlement/maintenance/bank', {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateMaintenance(qc),
    /* No writeFailedAs: refusing to unhook a bank a merchant still uses is the
       MESSAGE, and the page shows the server's sentence verbatim. */
  });
};

export const useSettlementBatches = () => useQuery({
  queryKey: ['settlement-batches'],
  queryFn: () => authedFetch<{ batches: SettlementBatch[] }>(`/accounting/settlement/batches`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSettlementBatch = (batchId: number | null) => useQuery({
  queryKey: ['settlement-batch', batchId],
  enabled: batchId != null,
  queryFn: () => authedFetch<{
    batch: SettlementBatch;
    acquirer: { code: string; hasUniqueRef: boolean | null; dateToleranceDays: number };
    buckets: Record<string, number>;
    rows: SettlementRow[];
  }>(`/accounting/settlement/batches/${batchId}`),
  staleTime: 0,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export type UploadResult = {
  batchId: number;
  rows: number;
  /** Summary/total rows in the file that are not transactions. */
  skippedLines: number;
  statedNetSen: number | null;
  adjustmentSen: number;
  grossSen: number; feeSen: number; netSen: number;
  periodFrom: string; periodTo: string;
  buckets: Record<string, number>;
};

export const useUploadStatement = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      acquirerCode: string; fileName: string; content: string;
      summaryFeeSen?: number | null;
      /** YYYY-MM — only needed when the file's dates carry no year. */
      statementMonth?: string | null;
    }) =>
      authedFetch<UploadResult>(`/accounting/settlement/batches`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settlement-batches'] }); },
    /* No writeFailedAs here: an unreadable statement is the MESSAGE, and the
       page shows the server's sentence verbatim (§2.14). */
  });
};

const invalidateAfterPosting = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['settlement-batch'] });
  /* The LIST too, not just the open report. Its rows carry the counts every
     screen reads — how many are ready to confirm, how many are still open —
     and leaving them stale is what left "Confirm all 4 matched" on screen
     beside four lines already stamped done · JE-2608-0013. */
  void qc.invalidateQueries({ queryKey: ['settlement-batches'] });
  void qc.invalidateQueries({ queryKey: ['settlement-watchlist'] });
  void qc.invalidateQueries({ queryKey: ['account-balances'] });
  void qc.invalidateQueries({ queryKey: ['control-check'] });
  void qc.invalidateQueries({ queryKey: ['daily-bank'] });
};

export const useConfirmSettlementRow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rowId, ...body }: {
      rowId: number;
      matchReason: 'ref' | 'amount+date' | 'manual';
      payments: Array<{ source: string; id: string; docNo: string | null; amountSen: number }>;
    }) => authedFetch<{ ok: boolean; status: string; jeNo?: string }>(
      `/accounting/settlement/rows/${rowId}/confirm`, { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: () => invalidateAfterPosting(qc),
  });
};

/* The door the ignore refusal points at: reverse the fee entry, release the
   payments, send the row back to the deciding pile. Same invalidations as
   confirming — the ledger moved, just in the other direction. */
export const useUnconfirmSettlementRow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rowId: number) => authedFetch<{ ok: boolean; reversalJeNo?: string }>(
      `/accounting/settlement/rows/${rowId}/unconfirm`, { method: 'POST', body: '{}' },
    ),
    onSuccess: () => invalidateAfterPosting(qc),
  });
};

export const useConfirmMatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: number) => authedFetch<{ attempted: number; confirmed: number; failed: Array<{ rowId: number; reason: string }>; statementCharge: { status: string; jeNo?: string } | null }>(
      `/accounting/settlement/batches/${batchId}/confirm-matched`, { method: 'POST', body: '{}' },
    ),
    onSuccess: () => invalidateAfterPosting(qc),
    onError: writeFailedAs('Settlements not confirmed'),
  });
};

/** "The money is in the bank, on this day." The second step of the owner's
    two-step: reconciling the card machine booked the fee; this books the payout
    and empties what the acquirer still owed. */
export const useMarkBatchReceived = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ batchId, receivedOn, amountSen }: { batchId: number; receivedOn: string; amountSen?: number | null }) =>
      authedFetch<{ ok: boolean; status: string; jeNo?: string; amountSen: number; receivedSen: number; outstandingSen: number }>(
        `/accounting/settlement/batches/${batchId}/received`,
        { method: 'POST', body: JSON.stringify({ receivedOn, amountSen }) },
      ),
    onSuccess: () => invalidateAfterPosting(qc),
  });
};

/** Take one credit back off a statement — the wrong date, the wrong amount, or
    money that turned out to belong to another statement. Reverses its entry. */
export const useUndoReceipt = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (receiptId: number) =>
      authedFetch<{ ok: boolean; status: string; jeNo?: string }>(
        `/accounting/settlement/receipts/${receiptId}/undo`, { method: 'POST', body: '{}' },
      ),
    onSuccess: () => invalidateAfterPosting(qc),
    onError: writeFailedAs('Credit not removed'),
  });
};

/* ── The payment advice: the payer's own answer sheet ────────────────────────
   Public Bank sends one IBG advice when it pays: this much money, these
   settlement days, into this account. Uploading it here is what lets the bank
   matcher allocate one credit across however many reports the advice names —
   without it the matcher searches for a combination and stops at four. */

export type PayoutDayState = 'AGREES' | 'DIFFERS' | 'REPORT_MISSING' | 'REPORT_NOT_RECONCILED';

/** One settlement date of an advice, against the report for that date. */
export type PayoutDay = {
  settledOn: string;
  /** What the advice says that day came to. */
  adviceNetSen: number;
  batchId: number | null;
  fileName: string | null;
  /** What the uploaded report itself nets, when there is one. */
  reportNetSen: number | null;
  /** report − advice. Zero is agreement; anything else is the finding. */
  differenceSen: number | null;
  reportOpenLines: number | null;
  state: PayoutDayState;
};

export type PayoutStatus = {
  netSen: number;
  days: PayoutDay[];
  /** Every day has a report, they all agree, and every report is reconciled. */
  readyToReceive: boolean;
  /** One sentence saying what is in the way, or null when nothing is. */
  blockedBy: string | null;
};

export type Payout = {
  id: number;
  acquirer_code: string;
  file_name: string;
  advice_date: string | null;
  payee_bank: string | null;
  payee_account_no: string | null;
  gross_sen: number;
  commission_sen: number;
  net_sen: number;
  uploaded_by: string | null;
  /** Re-checked against TODAY'S reports on every read, not stored. */
  status: PayoutStatus;
};

export const usePayouts = () => useQuery({
  queryKey: ['settlement-payouts'],
  queryFn: () => authedFetch<{ payouts: Payout[] }>(`/accounting/settlement/payouts`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useUploadPayoutAdvice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { acquirerCode: string; fileName: string; contentBase64: string }) =>
      authedFetch<{ ok: boolean; payoutId: number; status: PayoutStatus }>(`/accounting/settlement/payouts`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settlement-payouts'] }); },
    /* No writeFailedAs: an unreadable advice is the MESSAGE, and the page shows
       the server's sentence verbatim (§2.14). */
  });
};

export const useIgnoreSettlementRow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rowId, restore, notes }: { rowId: number; restore?: boolean; notes?: string | null }) =>
      authedFetch<{ ok: boolean }>(`/accounting/settlement/rows/${rowId}/ignore`, {
        method: 'POST', body: JSON.stringify({ restore: restore === true, notes: notes ?? null }),
      }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settlement-batch'] }); },
    onError: writeFailedAs('Line not updated'),
  });
};

export type Watchlist = {
  from: string; to: string; clean: boolean;
  recordedNotArrived: Array<SettlementCandidate & { ageDays: number; acquirerCode: string }>;
  arrivedNotRecorded: Array<{ id: number; acquirer_code: string; txn_date: string; ref: string | null; gross_sen: number; notes: string | null }>;
};

export type AgeBucket = '0-7' | '8-14' | '15-30' | 'over-30';

export type InTransitLine = {
  acquirerCode: string;
  source: 'SOPAY' | 'SIPAY';
  paymentId: string;
  docNo: string;
  paidOn: string;
  amountSen: number;
  approvalCode: string | null;
  /** Who keyed the payment in — resolved to a name, null when unresolvable. */
  recordedBy: string | null;
  recordedById: string | null;
  ageDays: number;
  /** NOT_ON_A_STATEMENT  — the acquirer has not reported it yet.
   *  MATCHED_NOT_POSTED  — reported and matched, waiting to be confirmed.
   *  RECONCILED_NOT_PAID — confirmed (its fee is booked), payout not arrived;
   *                        amountSen is the NET for these, matching the ledger. */
  state: 'NOT_ON_A_STATEMENT' | 'MATCHED_NOT_POSTED' | 'RECONCILED_NOT_PAID';
};

export type InTransit = {
  from: string;
  to: string;
  totalSen: number;
  /** acquirer -> age bucket -> total. A bucket with nothing in it is ABSENT,
      so the type is Partial: the screen has to ask before it reads. */
  ageing: Record<string, Partial<Record<AgeBucket, { count: number; sen: number }>>>;
  lines: InTransitLine[];
};

/** Whose money is sitting in settlement-in-transit, line by line — the customer
    paid, and it has not reached the bank yet. */
export const useInTransit = () => useQuery({
  queryKey: ['settlement-in-transit'],
  queryFn: () => authedFetch<InTransit>(`/accounting/settlement/in-transit`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export const useSettlementWatchlist = (params: { from?: string; to?: string; acquirer?: string } = {}) => {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.acquirer) qs.set('acquirer', params.acquirer);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return useQuery({
    queryKey: ['settlement-watchlist', suffix],
    queryFn: () => authedFetch<Watchlist>(`/accounting/settlement/watchlist${suffix}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
};
