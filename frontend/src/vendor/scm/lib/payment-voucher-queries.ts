// TanStack Query hooks for Payment Vouchers (Phase 1-B, MYR).
//
// HOUZS VENDOR — port of the PV slice of 2990's apps/backend/src/lib/flow-queries.ts.
// Import boundary only: all reads/writes go through the vendored authedFetch
// (→ /api/scm/payment-vouchers…). A DRAFT PV is created here, posted to the GL
// from the detail page, and cancelled (which reverses the GL entry + any PI
// settlement).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { retryUnlessClientError } from '../../../lib/retryPolicy';

// baseQuery is a custom-hook factory — only ever called from use* hooks below.
// eslint-disable-next-line react-hooks/rules-of-hooks
const baseQuery = <T>(key: string[], path: string) => useQuery({
  queryKey: key,
  queryFn: () => authedFetch<T>(path),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* List row + detail shapes are loosely typed (accessors read by name), matching
   the PI/GRN list convention. */
export type PaymentVoucherRow = Record<string, unknown> & {
  id: string;
  pv_number: string;
  status: string;
  voucher_date: string | null;
  payee_name: string;
  total_sen?: number;
  currency?: string;
  exchange_rate?: string | number | null;
  credit_account_code?: string;
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

export const usePaymentVouchers = (status?: string) => baseQuery<{ paymentVouchers: PaymentVoucherRow[] }>(
  ['payment-vouchers', status ?? 'all'], `/payment-vouchers${status ? `?status=${status}` : ''}`,
);

export const usePaymentVoucherDetail = (id: string | null) => useQuery({
  queryKey: ['payment-voucher-detail', id],
  queryFn: () => authedFetch<{
    paymentVoucher: Record<string, unknown>;
    lines: Array<Record<string, unknown>>;
    allocations: PaymentVoucherAllocation[];
  }>(`/payment-vouchers/${id}`),
  enabled: !!id,
});

/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a voucher field. Pass one per voucher
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME pvNumber — instead of raising a second voucher to pay the same
   supplier. Omitting it is exactly today's behaviour (the middleware no-ops).

   NOT on fix/so-idempotency's list, and the omission is worth naming: this is
   the most literal money-out document in the app, and lib/idempotency.ts even
   cites this file — but for /post and /cancel, which "detect their own replay
   and echo back". CREATE has no such guard. The domain-idempotent note was about
   two OTHER endpoints and quietly read as if the file were covered. */
export const useCreatePaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; pvNumber: string }>(`/payment-vouchers`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payment-vouchers'] }),
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
    },
  });
};

export const usePostPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ ok: true; jeNo?: string }>(`/payment-vouchers/${id}/post`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      // A post settles linked PIs — refresh the PI list/detail too.
      void qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
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
    mutationFn: ({ pvId, allocations }: { pvId: string; allocations: Array<{ piId: string; amountSen: number }> }) =>
      authedFetch<{ ok: true; appliedSen: number; remainingSen: number }>(
        `/payment-vouchers/${pvId}/apply-advance`,
        { method: 'POST', body: JSON.stringify({ allocations }) },
      ),
    onSuccess: (_d, { pvId }) => {
      void qc.invalidateQueries({ queryKey: ['supplier-advances'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', pvId] });
      void qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

export const useCancelPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/payment-vouchers/${id}/cancel`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      void qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
    },
  });
};

/* ── Phase 3: the approval cycle. Each mutation refreshes the list, the
   detail, and the Daily Bank board — a voucher entering or leaving the queue
   moves the board's "available" figure. */
const approvalMutation = (path: 'submit' | 'withdraw' | 'check' | 'approve') => () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/payment-vouchers/${id}/${path}`, { method: 'POST' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', id] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
    },
  });
};
export const useSubmitPaymentVoucher = approvalMutation('submit');
export const useWithdrawPaymentVoucher = approvalMutation('withdraw');
export const useCheckPaymentVoucher = approvalMutation('check');
/* Approve posts the GL in the same request — the response is the post's. */
export const useApprovePaymentVoucher = approvalMutation('approve');

export const useRejectPaymentVoucher = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      authedFetch(`/payment-vouchers/${id}/reject`, { method: 'POST', body: JSON.stringify({ note }) }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['payment-vouchers'] });
      void qc.invalidateQueries({ queryKey: ['payment-voucher-detail', vars.id] });
      void qc.invalidateQueries({ queryKey: ['daily-bank'] });
    },
  });
};

/* ── Bill OCR (2026-09-02) — read incoming bills into voucher pre-fills.
   Each `bills` entry is ONE document; its files are its pages (the human
   groups pages at upload — the server never guesses). Nothing is written by
   this call. */
export type BillExtraction = {
  vendorName: string | null; vendorRegNo: string | null;
  documentKind: 'invoice' | 'bill' | 'receipt' | 'statement' | 'unknown';
  invoiceNumber: string | null; invoiceDate: string | null; dueDate: string | null;
  currency: string; totalSen: number | null; sstSen: number | null;
  lines: Array<{ description: string | null; amountSen: number | null }>;
};
/* Vendor memory (mig 0341) — what the operator saved the LAST time this
   vendor was paid; the reader hands it back so the form can pre-fill the
   account (owner: 我想要你要有记忆…自动帮我填，选account 等等). */
export type VendorMemory = { payeeName: string | null; debitAccountCode: string | null; purpose: string | null; timesSeen: number };

export type ExtractedBill =
  | { index: number; ok: true; extraction: BillExtraction; supplierMatch: { id: string; code: string | null; name: string; confidence: 'exact' | 'contains' } | null; memory: VendorMemory | null }
  | { index: number; ok: false; reason: string };

/* FileReader, not buf→btoa: a chunked fromCharCode spread stack-overflows on a
   multi-megabyte PDF, and readAsDataURL hands back base64 in one move. */
export const fileToBase64 = (f: File): Promise<string> => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onerror = () => { reject(new Error(`${f.name} could not be read from disk.`)); };
  r.onload = () => { resolve(String(r.result).split(',')[1] ?? ''); };
  r.readAsDataURL(f);
});

export const useExtractBills = () => useMutation({
  mutationFn: (bills: Array<{ files: Array<{ name: string; mime: string; dataBase64: string }> }>) =>
    authedFetch<{ bills: ExtractedBill[] }>(`/payment-vouchers/extract`, {
      method: 'POST', body: JSON.stringify({ bills }),
    }),
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
/* One file as the scan/upload paths carry it (same shape useExtractBills
   sends) — built once from the File and reused for read + attach. */
export type PvFilePayload = { name: string; mime: string; dataBase64: string };
/* What a voucher file may be — the server's PV_FILE_MIMES (pv-files.ts),
   as an <input accept>. */
export const PV_FILE_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

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

/* The authed byte fetch behind both attachment readers (authedFetch
   JSON-parses, so it can't carry these). Same Worker-proxy pattern as
   slip.ts's fetchSlipAsObjectUrl, reusing the exported API_URL instead of
   declaring another copy. */
async function fetchPvFileResponse(pvId: string, fileId: string): Promise<Response> {
  const token = readAuthToken();
  if (!token) throw new Error('Your session has expired — please sign in again.');
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(60_000); } catch { signal = undefined; } // pre-2022 browsers
  const res = await correlatedFetch(`${API_URL}/payment-vouchers/${pvId}/files/${fileId}`, {
    headers: { authorization: `Bearer ${token}`, ...companyHeader() },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw correlateError(new Error(humanApiError(res.status, text)), requestIdFromResponse(res));
  }
  return res;
}

/* View one attachment as a blob object URL. The caller revokes it. */
export async function fetchPvFileBlobUrl(pvId: string, fileId: string): Promise<{ url: string; contentType: string }> {
  const res = await fetchPvFileResponse(pvId, fileId);
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  return consumeCorrelated(res, async () => ({
    url: URL.createObjectURL(await res.blob()),
    contentType,
  }));
}

/* The print's merge lives ON THE WORKER (backend pv-files.ts print-bundle +
   lib/pdf-attach.ts): the stored bills are in R2 next door, and pdf-lib in
   the browser would cost ~200KB gzip against a bundle gate that allows one
   change +60. So the client posts the RENDERED voucher page(s) up — one
   part per voucher — and receives one finished PDF back: voucher A, A's
   files in sort order, voucher B, B's… Raw fetch (binary response;
   authedFetch JSON-parses). */
export async function fetchPvPrintBundle(parts: Array<{ pvId: string; voucherBase64: string }>): Promise<Blob> {
  const token = readAuthToken();
  if (!token) throw new Error('Your session has expired — please sign in again.');
  let signal: AbortSignal | undefined;
  try { signal = AbortSignal.timeout(120_000); } catch { signal = undefined; } // pre-2022 browsers
  const res = await correlatedFetch(`${API_URL}/payment-vouchers/print-bundle`, {
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
