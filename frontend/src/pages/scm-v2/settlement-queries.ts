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
  /** Enough config to read a statement at all. */
  ready: boolean;
  /** Carries a unique reference — the only thing that may auto-match. */
  autoMatchable: boolean;
};

export type SettlementCandidate = {
  source: 'SOPAY' | 'SIPAY';
  id: string;
  docNo: string;
  paidOn: string;
  amountSen: number;
  approvalCode: string | null;
};

export type SettlementLink = {
  settlement_row_id: number;
  payment_source: string;
  payment_id: string;
  doc_no: string | null;
  amount_sen: number;
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
  comboHints: Array<[string, string]>;
  clue: string | null;
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
  status: string;
  uploaded_by: string | null;
  created_at: string;
};

export const useAcquirerSetup = () => useQuery({
  queryKey: ['settlement-setup'],
  queryFn: () => authedFetch<{ acquirers: AcquirerSetup[] }>(`/accounting/settlement/setup`),
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
