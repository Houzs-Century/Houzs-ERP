
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOC_FILE_ACCEPT } from './doc-file-mime';
import { API_URL, authedFetch, humanApiError } from './authed-fetch';
import { readAuthToken } from '../../../lib/authToken';
import { companyHeader } from '../../../lib/activeCompany';
import {
  consumeCorrelated,
  correlateError,
  correlatedFetch,
  requestIdFromResponse,
} from '../../../lib/requestCorrelation';
import { idempotentInit } from '../../../lib/idempotency';
import type { EventSuggestion } from './event-queries';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { reportInBandFailure, type InBandFailure } from './mutation-error';
import { runAiRead, runOneAiRead, type AiReadStage } from './ai-read-job';

// eslint-disable-next-line react-hooks/rules-of-hooks
const baseQuery = <T>(key: string[], path: string) => useQuery({
  queryKey: key,
  queryFn: () => authedFetch<T>(path),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export type PaymentVoucherRow = Record<string, unknown> & {
  id: string;
  pv_number: string;
  status: string;
  voucher_date: string | null;
  payee_name: string;
  total_sen?: number;
  bank_charge_sen?: number | null;
  currency?: string;
  exchange_rate?: string | number | null;
  credit_account_code?: string;
  notes?: string | null;
  /** The Description: what is paid for, as the bills say it — an AP payment's invoices'
      lines, else its own lines, else its requests' purposes, else the remark; never the
      bill number (owner 2026-11-09; server: payment-vouchers-describe.ts). */
  description_text?: string;
  pay_bank?: string | null;
  pay_account_no?: string | null;
  pay_account_name?: string | null;
  supplier?: { id: string; code: string; name: string } | null;
  /* The owner's four layers (2026-09-02). No marks: raw Draft. submitted:
     Prepared (still editable). checked: locked, on Daily Bank's pending.
     approved: the approve posted the GL — status flips POSTED with it. */
  submitted_at?: string | null;
  submitted_by?: string | null;
  checked_at?: string | null;
  checked_by?: string | null;
  approved_at?: string | null;
  approved_by?: string | null;
  advance_remaining_sen?: number | null;
  je_no?: string | null;
};

export type PaymentVoucherAllocation = {
  id: string;
  amountSen: number;
  piId: string | null;
  invoiceNumber: string | null;
  supplierInvoiceRef: string | null;
  currency: string | null;
  totalSen: number | null;
  paidSen: number | null;
  status: string | null;
};

/** The list (the newest 500), or with `q` any voucher of every stage and month
    (at most 200, `capped` when cut); `counts` adds each stage's count over the
    whole company (the redesign's chips). */
export const usePaymentVouchers = (opts: { status?: string; q?: string; counts?: boolean; enabled?: boolean } = {}) => {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.q) params.set('q', opts.q);
  if (opts.counts) params.set('counts', '1');
  const qs = params.toString();
  return useQuery({
    queryKey: ['payment-vouchers', opts.status ?? 'all', opts.q ?? '', opts.counts ? 'counts' : 'plain'],
    queryFn: () => authedFetch<{ paymentVouchers: PaymentVoucherRow[]; counts?: Record<string, number>; q?: string; capped?: boolean }>(`/payment-vouchers${qs ? `?${qs}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
    enabled: opts.enabled ?? true,
  });
};

/** The Payment listing (owner 2026-11-08): the vouchers dated up to `to` (and
    from `from`) at the stages asked, oldest first — whole, never cut short. */
export type PaymentListingStage = 'DRAFT' | 'PREPARED' | 'CHECKED' | 'POSTED' | 'CANCELLED';
export type PaymentListingRow = PaymentVoucherRow & { stage: PaymentListingStage };
export const usePaymentListing = (q: { from: string; to: string; stages: PaymentListingStage[] }) => {
  const params = new URLSearchParams({ to: q.to, stages: q.stages.join(',') });
  if (q.from) params.set('from', q.from);
  return useQuery({
    queryKey: ['payment-listing', q.from, q.to, q.stages.join(',')],
    queryFn: () => authedFetch<{ vouchers: PaymentListingRow[]; from: string | null; to: string; stages: PaymentListingStage[] }>(`/payment-vouchers/listing?${params.toString()}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
    enabled: q.stages.length > 0,
  });
};

export const usePaymentVoucherDetail = (id: string | null) => useQuery({
  queryKey: ['payment-voucher-detail', id],
  queryFn: () => authedFetch<{
    paymentVoucher: Record<string, unknown>;
    lines: Array<Record<string, unknown>>;
    allocations: PaymentVoucherAllocation[];
  }>(`/payment-vouchers/${id}`),
  enabled: !!id,
});

export const useCreatePaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; pvNumber: string }>(`/payment-vouchers`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
      void qc.invalidateQueries({ queryKey: ['payment-request-bill-matches'] });
      void qc.invalidateQueries({ queryKey: ['payment-requests'] });
    },
  });
};

export const useUpdatePaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ paymentVoucher: Record<string, unknown> }>(`/payment-vouchers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', vars.id] });
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    },
  });
};

/* A voucher's words and the bank it pays into, until it is approved (owner
   2026-11-06: 有时我要改 description; 2026-11-09: 可以，开放). The bank rides only
   when it was changed. */
export const useUpdatePvText = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; notes: string; lines: Array<{ id: string; description: string }>;
      payToBankName?: string | null; payToAccountNo?: string | null; payToAccountName?: string | null;
    }) =>
      authedFetch<{ paymentVoucher: Record<string, unknown> }>(`/payment-vouchers/${id}/text`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', vars.id] });
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['payment-listing'] });
    },
  });
};

const invalidatePvSettlement = (qc: ReturnType<typeof useQueryClient>) => {
  for (const k of ['purchase-invoices', 'purchase-invoice-detail', 'ap-invoices', 'ap-invoice', 'supplier-advances', 'pv-reservations', 'daily-bank', 'journal-entries']) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
};

export const usePostPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true; jeNo?: string } & InBandFailure>(`/payment-vouchers/${id}/post`, { method: 'POST' }),
    onSuccess: (d, id) => {
      reportInBandFailure('Voucher posted, but not every step finished', d);
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      invalidatePvSettlement(qc);
    },
  });
};

/* ── 预付挂在 supplier (2026-09-02) ───────────────────────────────────────────
   The open advances (vouchers that paid ahead, with money still on them) and
   the knock-off that spends one against real invoices. Applying posts
   NOTHING — both legs already live in AP — so only the PI side refreshes. */
export type SupplierAdvance = {
  id: number; supplier_id: string; pv_id: string; pv_number: string;
  amount_sen: number; applied_sen: number; remaining_sen: number; created_at: string;
};
export const useSupplierAdvances = (supplierId: string | null) => useQuery({
  queryKey: ['supplier-advances', supplierId ?? 'all'],
  queryFn: () => authedFetch<{ advances: SupplierAdvance[]; totalRemainingSen: number }>(
    `/payment-vouchers/advances/list${supplierId ? `?supplierId=${encodeURIComponent(supplierId)}` : ''}`,
  ),
  staleTime: 15_000,
  retry: retryUnlessClientError,
});

export const useApplyAdvance = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pvId, allocations }: { pvId: string; allocations: Array<{ piId?: string; apInvoiceId?: string; amountSen: number }> }) =>
      authedFetch<{ ok: true; appliedSen: number; remainingSen: number }>(
        `/payment-vouchers/${pvId}/apply-advance`,
        { method: 'POST', body: JSON.stringify({ allocations }) },
      ),
    onSuccess: (_d, { pvId }) => {
      void qc.invalidateQueries({ queryKey: ['supplier-advances'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', pvId] });
      void qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      void qc.invalidateQueries({ queryKey: ['ap-invoices'] });
      void qc.invalidateQueries({ queryKey: ['ap-invoice'] });
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
    },
  });
};

export const useCancelPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<InBandFailure>(`/payment-vouchers/${id}/cancel`, { method: 'POST' }),
    onSuccess: (d, id) => {
      reportInBandFailure('Voucher cancelled, but not every step finished', d);
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      invalidatePvSettlement(qc);
      void qc.invalidateQueries({ queryKey: ['payment-requests'] });
    },
  });
};

const approvalMutation = (path: 'submit' | 'withdraw' | 'check' | 'approve') => () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<InBandFailure>(`/payment-vouchers/${id}/${path}`, { method: 'POST' }),
    onSuccess: (d, id) => {
      if (path === 'approve') reportInBandFailure('Voucher posted, but not every step finished', d);
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
      if (path === 'approve') invalidatePvSettlement(qc);
    },
  });
};
export const useSubmitPaymentVoucher = approvalMutation('submit');
export const useWithdrawPaymentVoucher = approvalMutation('withdraw');
export const useCheckPaymentVoucher = approvalMutation('check');
export const useApprovePaymentVoucher = approvalMutation('approve');

/* Remind approver (the redesign's e8; owner 2026-11-03: 主要是付款吧) — a note in
   the approver's bell about checked vouchers. Posts nothing and changes no
   voucher, so only the trail it writes is refreshed. One voucher from the row,
   the ticked ones from the batch bar (one note for all of them). Server:
   backend/src/scm/routes/payment-vouchers-remind.ts. */
export type PvRemindRefusal = { id: string; pvNumber: string | null; error: string; message: string };
export type PvRemindResult = {
  reminded: Array<{ id: string; pvNumber: string }>;
  refused: PvRemindRefusal[];
  approvers: number;
  nextAt: string;
};
export const useRemindApprover = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      authedFetch<PvRemindResult>('/payment-vouchers/remind', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: (d) => {
      for (const r of d.reminded) void qc.invalidateQueries({ queryKey: ['scm-entity-audit-log', 'PAYMENT_VOUCHER', r.id] });
    },
  });
};

export const useRejectPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      authedFetch(`/payment-vouchers/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['finance-todo'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', vars.id] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
    },
  });
};

export type BillExtraction = {
  vendorName: string | null; vendorRegNo: string | null;
  documentKind: 'invoice' | 'bill' | 'receipt' | 'statement' | 'proforma' | 'quotation' | 'payment_proof' | 'summary' | 'unknown';
  severalReceipts?: boolean;
  invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null;
  currency: string; totalSen: number | null; sstSen: number | null;
  lines: Array<{ description: string | null; amountSen: number | null }>;
  /** The event the bill prints (owner 2026-09-30) — read, never matched here. */
  event?: { name: string | null; venue: string | null; booth: string | null; dateFrom: string | null; dateTo: string | null } | null;
};
/* Vendor memory (mig 0341) — what the operator saved the LAST time this
   vendor was paid; the reader hands it back so the form can pre-fill the
   account (owner: 我想要你要有记忆…自动帮我填，选account 等等). */
export type VendorMemory = { payeeName: string | null; debitAccountCode: string | null; purpose: string | null; timesSeen: number };

export type ExtractedBill =
  | {
    index: number; ok: true; extraction: BillExtraction; supplierMatch: { id: string; code: string | null; name: string; confidence: 'exact' | 'contains' } | null; memory: VendorMemory | null;
    eventSuggestions?: EventSuggestion[];
  }
  | { index: number; ok: false; reason: string };

export const fileToBase64 = (f: File): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onerror = () => { reject(new Error(`${f.name} could not be read from disk.`)); };
  r.onload = () => { resolve(String(r.result).split(',')[1] ?? ''); };
  r.readAsDataURL(f);
});

type BillsToRead = Array<{ files: Array<{ name: string; mime: string; dataBase64: string }> }>;
export async function extractBills(
  bills: BillsToRead, onStage: ((index: number, stage: AiReadStage) => void) | null,
): Promise<{ bills: ExtractedBill[] }> {
  const read = await runAiRead<{ bills: ExtractedBill[] }>('/payment-vouchers/extract', { bills }, onStage);
  return {
    bills: read.map((r, index): ExtractedBill => {
      if (!r.ok) return { index, ok: false, reason: r.error.message };
      const got = r.body.bills.at(0);
      return got ? { ...got, index } : { index, ok: false, reason: 'The reader sent nothing back — read it again.' };
    }),
  };
}

export const useExtractBills = () => useMutation({
  mutationFn: (input: BillsToRead | { bills: BillsToRead; onStage: (index: number, stage: AiReadStage) => void }) =>
    Array.isArray(input) ? extractBills(input, null) : extractBills(input.bills, input.onStage),
});

/* The bill a payment request carries, read when Finance opens the voucher or
   AP invoice that answers it (owner 2026-09-30, 6.2): the server reads the
   request's own files, so nothing is uploaded twice. No bill → `bills: []`. */
export const useExtractRequestBill = (onStage: ((stage: AiReadStage) => void) | null = null) => useMutation({
  mutationFn: (requestId: string) =>
    runOneAiRead<{ bills: ExtractedBill[] }>('/payment-vouchers/extract', { fromRequest: requestId }, onStage),
});

/* ── PV attachments (2026-09-03) — the bill LIVES with its voucher. Before
   this the scan flow read the bill and kept nothing, so there was no evidence
   to show or to print (owner: 我希望可以 print pv include ocr 的文件一起).
   Bytes stream through the Worker's R2 binding; scm.acc_pv_files (0352) is
   the index, sort_no = attach order = print order. */
export type PvFile = {
  id: string; file_name: string; mime: string;
  size_bytes: number; sort_no: number; created_at: string;
};
export type PvFilePayload = { name: string; mime: string; dataBase64: string };
export const PV_FILE_ACCEPT = DOC_FILE_ACCEPT;

export const usePvFiles = (pvId: string | null) => useQuery({
  queryKey: ['pv-files', pvId],
  queryFn: () => authedFetch<{ files: PvFile[] }>(`/payment-vouchers/${pvId}/files`),
  enabled: !!pvId,
  retry: retryUnlessClientError,
});

export const useUploadPvFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pvId, file }: { pvId: string; file: PvFilePayload }) =>
      authedFetch<{ ok: true; file: PvFile }>(`/payment-vouchers/${pvId}/files`, {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, mime: file.mime, dataBase64: file.dataBase64 }),
      }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['pv-files', vars.pvId] });
    },
  });
};

export const useDeletePvFile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ pvId, fileId }: { pvId: string; fileId: string }) =>
      authedFetch<{ ok: true }>(`/payment-vouchers/${pvId}/files/${fileId}`, { method: 'DELETE' }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['pv-files', vars.pvId] });
    },
  });
};

async function fetchDocFileResponse(path: string): Promise<Response> {
  const token = readAuthToken();
  if (!token) throw new Error('Your session has expired — please sign in again.');
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(60_000); } catch { signal = undefined; }
  const res = await correlatedFetch(`${API_URL}${path}`, {
    headers: { authorization: `Bearer ${token}`, ...companyHeader() },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  return res;
}

export async function fetchDocFileBlobUrl(path: string): Promise<{ url: string; contentType: string }> {
  const res = await fetchDocFileResponse(path);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  return consumeCorrelated(res, async () => ({
    url: URL.createObjectURL(await res.blob()),
    contentType,
  }));
}
export const fetchPvFileBlobUrl = (pvId: string, fileId: string): Promise<{ url: string; contentType: string }> =>
  fetchDocFileBlobUrl(`/payment-vouchers/${pvId}/files/${fileId}`);

export async function fetchPrintBundle(path: string, parts: unknown[]): Promise<Blob> {
  const token = readAuthToken();
  if (!token) throw new Error('Your session has expired — please sign in again.');
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(120_000); } catch { signal = undefined; }
  const res = await correlatedFetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...companyHeader() },
    body: JSON.stringify({ parts }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  return consumeCorrelated(res, () => res.blob());
}
export const fetchPvPrintBundle = (parts: Array<{ pvId: string; voucherBase64: string }>): Promise<Blob> =>
  fetchPrintBundle('/payment-vouchers/print-bundle', parts);

/* Imperative twin of usePaymentVoucherDetail for the batch print (owner:
   可选多张 pv + document) — a loop over ticked rows has no hook to call, and
   each voucher must be CURRENT at print time, not a stale cache. */
export async function fetchPvPrintDetail(pvId: string): Promise<{
  paymentVoucher: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  allocations: PaymentVoucherAllocation[];
}> {
  return authedFetch(`/payment-vouchers/${pvId}`);
}

/** What UNPOSTED vouchers have already applied to each of a supplier's
    invoices (docs/bugs/0653) — the picker subtracts it, so an invoice a saved
    voucher already covers leaves the list (owner 2026-09-07: payment 已经分配了
    就不要显示). excludePvId keeps the voucher being edited out of its own way. */
export type PvReservations = { byPi: Record<string, number>; byApInvoice: Record<string, number>; holders: Record<string, string[]> };
export const NO_RESERVATIONS: PvReservations = { byPi: {}, byApInvoice: {}, holders: {} };
export const usePvReservations = (supplierId: string | null, excludePvId: string | null = null) => useQuery({
  queryKey: ['pv-reservations', supplierId ?? 'none', excludePvId ?? ''],
  queryFn: () => authedFetch<PvReservations>(
    `/payment-vouchers/reservations/list?supplierId=${encodeURIComponent(supplierId ?? '')}${excludePvId ? `&excludePvId=${encodeURIComponent(excludePvId)}` : ''}`,
  ),
  enabled: Boolean(supplierId),
  staleTime: 10_000,
  retry: retryUnlessClientError,
});

/* ── Customer Refund (payment-voucher.md §14) ─────────────────────────────
   The document a refund refunds — 认单为主: the operator names the Sales
   Order (any status) or the Sales Invoice (CANCELLED only), and the server
   answers with the customer, every payment it collected (booked = reached
   this ledger; imported = brought over from AutoCount, which counts on an
   order too — owner 2026-10-05), the refunds already on it and the headroom. */
export type RefundPayment = { id: string; paidOn: string; method: string; provider: string | null; amountSen: number; booked: boolean; imported?: boolean };
export type RefundVoucherRow = { id: string; pvNumber: string; status: string; voucherDate: string; totalSen: number };
export type RefundSource = {
  type: 'SO' | 'SI';
  docNo: string;
  status: string | null;
  customer: { name: string | null; phone: string | null; customerId: string | null; debtorCode: string | null };
  payments: RefundPayment[];
  bookedSen: number;
  importedSen?: number;
  refunds: RefundVoucherRow[];
  refundedSen: number;
  /** Refund requests on the order still waiting for Finance (owner 2026-10-14)
      — spoken for, all but the one being answered. Optional against an older server. */
  requestedSen?: number;
  refundableSen: number;
  /** Deposit invoices still standing on the order, and what is left on them
      (docs/bugs/0860). Optional only for the minute a newer screen reads an
      older server. */
  deposits?: { count: number; standingSen: number };
  eligible: boolean;
  reason: string | null;
};

/** `excludeRequestId` — the refund request this voucher answers: its own amount
    is not held against it (owner 2026-10-14). */
export const useRefundSource = (type: 'SO' | 'SI', docNo: string, excludePvId: string | null = null, excludeRequestId: string | null = null) => useQuery({
  queryKey: ['pv-refund-source', type, docNo.trim(), excludePvId, excludeRequestId],
  enabled: docNo.trim().length > 0,
  retry: false,
  queryFn: () => authedFetch<{ source: RefundSource }>(
    `/payment-vouchers/refund-source?type=${type}&docNo=${encodeURIComponent(docNo.trim())}${excludePvId ? `&excludePvId=${encodeURIComponent(excludePvId)}` : ''}${excludeRequestId ? `&excludeRequestId=${encodeURIComponent(excludeRequestId)}` : ''}`,
  ),
});
