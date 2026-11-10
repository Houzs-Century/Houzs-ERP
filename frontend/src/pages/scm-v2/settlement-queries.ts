// Acquirer settlement reconciliation — the hooks behind the layer-3 screen
// (accounting phase 2B; brief §3.5 layer 3). Every rule lives on the server;
// these are transport only, so the page cannot drift from what actually posts.

import { useCallback } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
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
  /** The other names the sales team keys this merchant as on a payment
      (owner 2026-10-21: Pinelabs = AEON, Public = PBB). */
  so_names?: string[];
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
  /** On a "Find the sale" result: the payment's own amount is the line's exact
      gross — the system's guess, ranked first, never the only choice. */
  possible?: boolean;
  /** The order's salesperson and the payment's account sheet (the redesign's
      Sales and Account sheet columns) — on a report's candidates. */
  salesperson?: string | null;
  accountSheet?: string | null;
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
  /** The order's salesperson and the payment's account sheet (the redesign). */
  salesperson?: string | null;
  account_sheet?: string | null;
};

export type RefreshedLink = { settlementRowId: number; paymentSource: string; paymentId: string; docNo: string | null; fromSen: number; toSen: number };

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
  /** Lines confirmed TOGETHER against their payments (option B): the group's
      lines and their total. `linked` then holds the group's payments. */
  matched_with?: { leadRowId: number; lines: Array<{ rowId: number; lineNo: number; grossSen: number }>; grossSen: number } | null;
  candidates: SettlementCandidate[];
  /** Sets of payments that add up to the line — two orders on one swipe, or
      three. The screen flattens them into "these are worth a look". */
  comboHints: string[][];
  /** What the system itself would pick — pre-ticked, still yours to confirm.
      Empty unless there is exactly ONE way to make this line amount. */
  suggested?: SettlementCandidate[];
  clue: string | null;
  /** 'QR' for a DuitNow QR line (owner 2026-11-09: 0000PP 是 qr direct 去 bank
      的，不算卡机的): its sale is keyed Online and already in the bank, so it is
      linked, never posted. Null or absent: a card line. */
  channel?: 'QR' | null;
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
  /** The DuitNow QR lines the report carries and their money — in the bank by
      their sales, so no part of gross / fee / net above (owner 2026-11-09). */
  qr_count?: number;
  qr_gross_sen?: number;
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
      /** The other names this merchant is keyed as on a payment. */
      soNames?: string[];
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
  /** The other names the sales team keys this merchant as on a payment —
      shared by every company, like the report layout. */
  so_names?: string[];
  ready: boolean;
  autoMatchable: boolean;
  /* Keyed by company id, and only for the companies the server answered for —
     so a lookup can miss, and every reader has to say what it does then. */
  byCompany: Record<string, { enabled: boolean; linked: boolean; bankAccountCode: string | null; transitAccountCode?: string | null; feeAccountCode?: string | null } | undefined>;
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
  /** Each company's clearing accounts (326-/327-, not money) — where a
      machine's card money sits before the payout (owner 2026-09-07: one per
      bank). Keyed by company id; absent on an older server. */
  clearings?: Record<string, Array<{ account_code: string; account_name: string }> | undefined>;
  /** Active EXPENSE leaves per company — what a merchant fee may be booked to.
      Server-filtered to the same properties the posting gate checks, so a code
      offered here cannot be one the gate refuses (docs/bugs/0762). */
  feeAccounts?: Record<string, Array<{ account_code: string; account_name: string }> | undefined>;
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
    mutationFn: (body: { companyId: number; code: string; enabled?: boolean; bankAccountCode?: string | null; transitAccountCode?: string; feeAccountCode?: string }) =>
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

/** What matching a merchant's open lines again changed, for one company. */
export type RematchResult = {
  ok: true;
  acquirerCode: string;
  reports: number;
  lines: number;
  /** Open lines matched by reference now — what "Confirm all" posts. */
  matched: number;
  newlyMatched: number;
  released: number;
  failed: Array<{ rowId: number; reason: string }>;
};

/** Decide one merchant's OPEN report lines again for one company — run after
    the merchant's matching rule changes (owner 2026-10-21: 已经上传的报告也
    重新对一次). Nothing posts; the counts and the button move. */
export const useRematch = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { companyId: number; acquirerCode: string }) =>
      authedFetch<RematchResult>('/accounting/settlement/rematch', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settlement-batches'] });
      void qc.invalidateQueries({ queryKey: ['settlement-batch'] });
      void qc.invalidateQueries({ queryKey: ['settlement-watchlist'] });
    },
  });
};

export const useSettlementBatches = () => useQuery({
  queryKey: ['settlement-batches'],
  queryFn: () => authedFetch<{ batches: SettlementBatch[] }>(`/accounting/settlement/batches`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* HOW LONG A READ REPORT STAYS FRESH. It was 0, and the work list mounts one
   detail per report: every return from a report to the list re-read every
   report on it (one heavy request each), which is how two people made ~1,300
   detail requests a day. A posting still refreshes the report it touched at
   once (invalidateAfterPosting), and the report a person OPENS is always read
   fresh (useSettlementBatch) — the "opening it refreshes it" of docs/bugs/0833.
   What may be up to this old is another report's row on a list. */
export const BATCH_DETAIL_STALE_MS = 5 * 60_000;

const settlementBatchQuery = (batchId: number | null) => ({
  queryKey: ['settlement-batch', batchId],
  queryFn: () => authedFetch<{
    batch: SettlementBatch;
    acquirer: { code: string; hasUniqueRef: boolean | null; dateToleranceDays: number };
    buckets: Record<string, number>;
    rows: SettlementRow[];
    /** Unconfirmed links re-read their payment as the report opens (docs/bugs/0833): what moved. */
    refreshedLinks?: RefreshedLink[];
  }>(`/accounting/settlement/batches/${batchId}`),
  staleTime: BATCH_DETAIL_STALE_MS,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** The report a person has OPENED: read fresh every time it is opened. */
export const useSettlementBatch = (batchId: number | null) => useQuery({
  ...settlementBatchQuery(batchId),
  enabled: batchId != null,
  refetchOnMount: 'always' as const,
});

/** One report's lines as a ROW of a list: the cached read while it is fresh, so
    coming back to the list does not re-read every report on it. */
export const useSettlementBatchRow = (batchId: number) => useQuery(settlementBatchQuery(batchId));

/** Several reports' lines on one screen (Payments not matched yet's merchant report
    lines): each report read exactly as Merchant Recon reads it, so the two say the
    same thing about a line. */
type BatchDetail = Awaited<ReturnType<ReturnType<typeof settlementBatchQuery>['queryFn']>>;
/* One stable function: React Query re-runs a combine only when its results or
   the function change, so the screen's rows keep their identity between renders. */
const combineDetails = (results: ReadonlyArray<{ data?: BatchDetail; isLoading: boolean; isError: boolean }>) => ({
  details: results.map((r) => r.data),
  loading: results.some((r) => r.isLoading),
  failed: results.some((r) => r.isError),
});
export const useSettlementBatchDetails = (batchIds: readonly number[]) => useQueries({
  queries: batchIds.map((id) => settlementBatchQuery(id)),
  combine: combineDetails,
});

/** Several reports' lines at once, for an export: as the list already read them, so the
    file says what the screen says; one not read yet is read now. */
export const useReadSettlementBatches = () => {
  const qc = useQueryClient();
  return useCallback(
    (ids: readonly number[]) => Promise.all(ids.map((id) => qc.ensureQueryData(settlementBatchQuery(id)))),
    [qc],
  );
};

export type UploadResult = {
  batchId: number;
  rows: number;
  /** Summary/total rows in the file that are not transactions. */
  skippedLines: number;
  /** Lines already on another report of this acquirer — the same trading day,
      reference and gross — left out of this batch, each naming the report and
      line they are on (docs/bugs/0823). */
  alreadyOnReport: number;
  alreadyOnReportDetail: Array<{ lineNo: number; txnDate: string; ref: string; grossSen: number; batchId: number; fileName: string | null; lineNoThere: number }>;
  statedNetSen: number | null;
  adjustmentSen: number;
  grossSen: number; feeSen: number; netSen: number;
  /** The file's DuitNow QR lines — matched to Online sales, not owed through the clearing account. */
  qrLines?: number; qrSen?: number;
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

/** `postedTo`: the reports the write posted to by id, on screen or not. */
const invalidateAfterPosting = (qc: ReturnType<typeof useQueryClient>, postedTo: readonly number[]) => {
  /* The reports ON SCREEN, and the ones posted to. Any other report is left as
     read: re-read when it is opened, or once its read is older than
     BATCH_DETAIL_STALE_MS, instead of all of them on the next visit to a list. */
  void qc.invalidateQueries({ queryKey: ['settlement-batch'], type: 'active' });
  for (const id of postedTo) void qc.invalidateQueries({ queryKey: ['settlement-batch', id] });
  /* The LIST too, not just the open report. Its rows carry the counts every
     screen reads — how many are ready to confirm, how many are still open —
     and leaving them stale is what left "Confirm all 4 matched" on screen
     beside four lines already stamped done · JE-2608-0013. */
  void qc.invalidateQueries({ queryKey: ['settlement-batches'] });
  void qc.invalidateQueries({ queryKey: ['settlement-watchlist'] });
  void qc.invalidateQueries({ queryKey: ['account-balances'] });
  void qc.invalidateQueries({ queryKey: ['control-check'] });
  void qc.invalidateQueries({ queryKey: ['daily-bank'] });
  /* Finance's To do counts these lines; it moves with them. */
  void qc.invalidateQueries({ queryKey: ['finance-todo'] });
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
    onSuccess: () => invalidateAfterPosting(qc, []),
  });
};

/* Several lines of one report against several payments — the customer swiped
   twice for two orders (owner 2026-11-03, option B). The sum of the payments
   must be the sum of the lines, to the sen. */
export const useConfirmSettlementGroup = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      rowIds: number[];
      payments: Array<{ source: string; id: string; docNo: string | null; amountSen: number }>;
    }) => authedFetch<{ ok: boolean; status: string; jeNo?: string }>(
      '/accounting/settlement/rows/confirm-together', { method: 'POST', body: JSON.stringify(body) },
    ),
    onSuccess: () => invalidateAfterPosting(qc, []),
  });
};

/* "Not this" (owner 2026-11-03, batch 3 d2): release an unconfirmed line's
   match; the line goes back to be chosen and is not offered that payment again.
   Posts nothing. */
/** `payments`: the system's GUESS the line shows ("SOPAY:<id>" keys), for a line
    that holds no link (owner 2026-11-10). A linked line releases its link. */
export const useReleaseSettlementRow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ rowId, payments }: { rowId: number; payments: string[] }) => authedFetch<{ ok: boolean; released: string[] }>(
      `/accounting/settlement/rows/${rowId}/release`, { method: 'POST', body: JSON.stringify({ payments }) },
    ),
    onSuccess: () => invalidateAfterPosting(qc, []),
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
    onSuccess: () => invalidateAfterPosting(qc, []),
  });
};

export type ConfirmMatchedResult = {
  attempted: number;
  confirmed: number;
  failed: Array<{ rowId: number; reason: string }>;
  statementCharge: { status: string; jeNo?: string } | null;
};

/** One report's "post every line the reference matched" — the bare call, so a
    pile of reports can be posted with ONE refresh at the end (see
    useConfirmAcross in MerchantRecon). */
export const confirmMatchedBatch = (batchId: number) => authedFetch<ConfirmMatchedResult>(
  `/accounting/settlement/batches/${batchId}/confirm-matched`, { method: 'POST', body: '{}' },
);

/** Refresh everything a posting moves, once. */
export const useInvalidateAfterPosting = () => {
  const qc = useQueryClient();
  return (postedTo: readonly number[]) => invalidateAfterPosting(qc, postedTo);
};

export const useConfirmMatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: confirmMatchedBatch,
    onSuccess: (_r, batchId) => invalidateAfterPosting(qc, [batchId]),
    onError: writeFailedAs('Settlements not confirmed'),
  });
};

/** "The money is in the bank, on this day." The second step of the owner's
    two-step: reconciling the card machine booked the fee; this books the payout
    and empties what the acquirer still owed. */
export const useMarkBatchReceived = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ batchId, receivedOn, amountSen }: { batchId: number; receivedOn: string; amountSen?: number }) =>
      authedFetch<{ ok: boolean; status: string; jeNo?: string; amountSen: number; receivedSen: number; outstandingSen: number }>(
        `/accounting/settlement/batches/${batchId}/received`,
        { method: 'POST', body: JSON.stringify({ receivedOn, amountSen }) },
      ),
    onSuccess: (_r, v) => invalidateAfterPosting(qc, [v.batchId]),
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
    onSuccess: () => invalidateAfterPosting(qc, []),
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
  /** report − (advice + charge). Zero is agreement; anything else is the finding. */
  differenceSen: number | null;
  reportOpenLines: number | null;
  /** What the bank deducted from this day's payout and where Finance booked it
      (docs/bugs/0787) — 0 / null when nothing was. */
  chargeSen: number;
  chargeAccountCode: string | null;
  chargeNote: string | null;
  chargeJeNo: string | null;
  state: PayoutDayState;
};

/** An account a bank charge may be booked to: an active expense leaf of this
    company — the same list the Setup page offers for the merchant fee. */
export type ChargeAccount = { accountCode: string; accountName: string };

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
  queryFn: () => authedFetch<{
    payouts: Payout[];
    chargeAccounts: ChargeAccount[];
    /** Each acquirer's fee account — what the charge dialog defaults to. */
    feeAccountByAcquirer: Record<string, string | null>;
  }>(`/accounting/settlement/payouts`),
  staleTime: 15_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** Where a charge may be booked, alone — for a charge kept off a bank credit
    (owner 2026-09-30); read only once somebody opens that form. */
export const useChargeChoices = (enabled: boolean) => useQuery({
  queryKey: ['settlement-charge-accounts'],
  queryFn: () => authedFetch<{ chargeAccounts: ChargeAccount[]; feeAccountByAcquirer: Record<string, string | null> }>(`/accounting/settlement/charge-accounts`),
  enabled,
  staleTime: 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/** The bank deducted a charge from one day of an advice — book it where
    Finance says (docs/bugs/0787). The journal moves, so the entries list is
    re-read along with the advices. */
export const usePostPayoutCharge = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ payoutId, settledOn, ...body }: { payoutId: number; settledOn: string; amountSen?: number | null; accountCode: string; note: string }) =>
      authedFetch<{ ok: boolean; chargeSen: number; accountCode: string; jeNo: string }>(
        `/accounting/settlement/payouts/${payoutId}/days/${encodeURIComponent(settledOn)}/charge`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settlement-payouts'] });
      void qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
  });
};

export const useUndoPayoutCharge = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ payoutId, settledOn }: { payoutId: number; settledOn: string }) =>
      authedFetch<{ ok: boolean }>(
        `/accounting/settlement/payouts/${payoutId}/days/${encodeURIComponent(settledOn)}/charge`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settlement-payouts'] });
      void qc.invalidateQueries({ queryKey: ['journal-entries'] });
    },
  });
};

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
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['settlement-batch'], type: 'active' }); },
    onError: writeFailedAs('Line not updated'),
  });
};

export type Watchlist = {
  from: string; to: string; clean: boolean;
  /** acquirerCode null = keyed in without a bank; the server lists such a
      payment ONCE (docs/bugs/0688) and the screen shows it as 未标. */
  /** salespersonName: who sold it, off the order (owner 2026-09-10: 我想要看到
      salesman 的名字); null when the order names nobody or the payment is an
      invoice's. */
  /** ref / customer_so_no: the order's Ref No. (HC13025, ZNT6656), raw, for customerRefOf. */
  recordedNotArrived: Array<SettlementCandidate & { ageDays: number; acquirerCode: string | null; salespersonName?: string | null; ref?: string | null; customer_so_no?: string | null }>;
  arrivedNotRecorded: Array<{ id: number; acquirer_code: string; txn_date: string; ref: string | null; gross_sen: number; notes: string | null }>;
};

export type AgeBucket = '0-7' | '8-14' | '15-30' | 'over-30';

export type InTransitLine = {
  /** null = keyed in without a bank, listed once (docs/bugs/0688); the
      ageing table keys such money 未标. */
  acquirerCode: string | null;
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

/* "Find the sale" (docs/bugs/0792): the company's card payments the window
   could not offer, searched by document / customer / approval / amount. Off
   until the operator opens the search on a line. */
export const useFindPayments = (rowId: number | null, q: string) => useQuery({
  queryKey: ['settlement-find', rowId, q],
  queryFn: () => authedFetch<{ q: string; payments: Array<SettlementCandidate & { possible: boolean; method: string }> }>(
    `/accounting/settlement/rows/${rowId}/find?q=${encodeURIComponent(q)}`,
  ),
  enabled: rowId != null,
  staleTime: 10_000,
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
