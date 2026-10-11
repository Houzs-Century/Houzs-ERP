// ----------------------------------------------------------------------------
// Consignment Order query hooks — a faithful clone of the Sales Order hooks in
// flow-queries.ts, repointed at the parallel backend route mounted at
// `/consignment-orders` (which mirrors `/mfg-sales-orders` 1:1: same create
// body, same detail shape, same line/payment/debtor-search endpoints).
//
// Numbering on the backend is `CS-YYMM-NNN`. The request/response types are
// intentionally kept identical to the SO hooks so the cloned ConsignmentOrderNew
// / ConsignmentOrderDetail / ConsignmentOrders pages can render exactly like the
// SO ones with only the endpoint + query key swapped.
//
// Query key namespace: ['consignment-order'] (+ '-detail', '-audit-log', etc.)
// so consignment cache invalidation never collides with the SO cache.
//
// ── HOUZS VENDOR NOTES ──────────────────────────────────────────────────────
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The supabase import is dropped.
//   - The per-line photo multipart POST (which the source did by hand off the
//     supabase session token + raw URL) is repointed through authedFetch — the
//     vendored authedFetch omits the JSON content-type for FormData bodies so the
//     multipart boundary survives, exactly like the SO photo upload.
//   - serviceNotify maps to the vendored dialog-service serviceNotify.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed, writeFailedAs } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import { prepareImageForUpload } from '../../../lib/imagePipeline';

/* ── List ────────────────────────────────────────────────────────────── */
export const useConsignmentOrders = (status?: string) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-order', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ salesOrders: any[] }>(
    `/consignment-orders${status ? `?status=${status}` : ''}`,
  ),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── List (opt-in server-side pagination) ────────────────────────────────
   Sending `page` switches /consignment-orders into its paginated contract
   ({ salesOrders, total, page, pageSize }); the legacy useConsignmentOrders
   above (no page) still returns the historical unpaginated array. `q` searches
   doc_no + debtor_name (the columns the CO list already searches + that are in
   the header select). `sort` is 'col:dir' over
   { so_date, doc_no, debtor_name, status, local_total_centi } (default
   so_date:desc). placeholderData keepPrevious so paging doesn't flash empty. */
/* Full-set money KPIs returned by the paginated CO list (mirrors the SO list
   `aggregates` contract) — summed over the SAME filters as the page, so the KPI
   tiles stay full-set instead of page-scoped. */
export type ConsignmentOrderAggregates = { revenueCenti: number; outstandingCenti: number; paidCenti: number };
export const useConsignmentOrdersPaged = (params: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
  sort?: string;
  /* Outstanding-only overlay (?outstanding=1) — live balance > 0. Applied
     server-side so it stays correct across pages. */
  outstanding?: boolean;
}) => {
  const { page, pageSize, status, q, sort, outstanding } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  if (outstanding) usp.set('outstanding', '1');
  return useQuery<{ salesOrders: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentOrderAggregates }>({
    queryKey: ['consignment-order', 'list-paged', page, pageSize, status ?? '', q ?? '', sort ?? '', outstanding ? '1' : ''],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: ({ signal }) => authedFetch<{ salesOrders: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentOrderAggregates }>(`/consignment-orders?${usp.toString()}`, { signal }),
    placeholderData: (prev: unknown) => prev as { salesOrders: unknown[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentOrderAggregates } | undefined,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
};

/* ── Detail ──────────────────────────────────────────────────────────── */
export const useConsignmentOrderDetail = (docNo: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-order-detail', docNo],
  queryFn: () => authedFetch<{ salesOrder: any; items: any[] }>(`/consignment-orders/${docNo}`),
  enabled: Boolean(docNo), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* ── Create ──────────────────────────────────────────────────────────── */
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as an order field. Pass one per order
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME docNo — instead of raising the consignment order twice. Omitting it
   is exactly today's behaviour (the middleware no-ops).

   Mirrors useAddConsignmentOrderPayment below, idempotent since #657 while the
   order it pays for was not. */
export const useCreateConsignmentOrder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ docNo: string }>(`/consignment-orders`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consignment-order'] }),
  });
};

/* ── Header update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentOrderHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, ...body }: { docNo: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-orders/${docNo}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order'] });
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
    },
  });
};

/* ── Status update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentOrderStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, status }: { docNo: string; status: string }) =>
      authedFetch<{ salesOrder: unknown }>(`/consignment-orders/${docNo}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order'] });
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* ── Line items ──────────────────────────────────────────────────────── */
export const useAddConsignmentOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, ...item }: { docNo: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/consignment-orders/${docNo}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['consignment-order'] });
    },
  });
};

export const useUpdateConsignmentOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, ...item }: { docNo: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-orders/${docNo}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['consignment-order'] });
    },
  });
};

export const useDeleteConsignmentOrderItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId }: { docNo: string; itemId: string }) =>
      authedFetch<void>(`/consignment-orders/${docNo}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['consignment-order'] });
    },
    onError: writeFailed,
  });
};

/* ── Per-line photos (multipart) ─────────────────────────────────────── */
export type UploadConsignmentItemPhotoResult = {
  photoKey: string;
  photoUrl: string;
  /** WO-7 — signed URL for the `.thumb` sibling; absent from pre-thumb
   *  backends. Grids try it first and fall back to photoUrl on 404. */
  thumbUrl?: string;
  expiresAt?: string;
};

export const useUploadConsignmentItemPhoto = () => {
  const qc = useQueryClient();
  return useMutation({
    // HOUZS VENDOR: the bespoke supabase-token + raw-URL multipart POST is
    // repointed through authedFetch (it omits the JSON content-type for
    // FormData so the multipart boundary survives), exactly like the SO photo
    // upload.
    mutationFn: async ({ docNo, itemId, file }: {
      docNo: string; itemId: string; file: File;
    }): Promise<UploadConsignmentItemPhotoResult> => {
      /* WO-7 — downscale/re-encode + thumbnail in one decode pass; falls
         back to the original file (thumb: null) when compression is
         unavailable. */
      const prepared = await prepareImageForUpload(file);
      const fd = new FormData();
      fd.append('file', prepared.file);
      if (prepared.thumb) fd.append('thumb', prepared.thumb);
      return authedFetch<UploadConsignmentItemPhotoResult>(
        `/consignment-orders/${docNo}/items/${itemId}/photos`,
        { method: 'POST', body: fd },
      );
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
    },
  });
};

export type SignedConsignmentPhotoUrlResponse = {
  signedUrl: string;
  /** WO-7 — signed `.thumb` sibling URL (absent from pre-thumb backends). */
  thumbUrl?: string;
  expiresAt: string;
};

export async function fetchConsignmentItemPhotoSignedUrl(
  docNo: string,
  itemId: string,
  photoKey: string,
): Promise<SignedConsignmentPhotoUrlResponse> {
  return authedFetch<SignedConsignmentPhotoUrlResponse>(
    `/consignment-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}/signed`,
  );
}

export const useDeleteConsignmentItemPhoto = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, photoKey }: {
      docNo: string; itemId: string; photoKey: string;
    }) =>
      authedFetch<{ ok: boolean }>(
        `/consignment-orders/${docNo}/items/${itemId}/photos/${encodeURIComponent(photoKey)}`,
        { method: 'DELETE' },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order', vars.docNo] });
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
    },
    onError: writeFailedAs('Photo not deleted'),
  });
};

/* ── Line price override ─────────────────────────────────────────────── */
export const useOverrideConsignmentLinePrice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, itemId, overridePriceSen, reason }: {
      docNo: string; itemId: string; overridePriceSen: number; reason?: string;
    }) =>
      authedFetch<{ ok: boolean; itemId: string; newPrice: number }>(
        `/consignment-orders/${docNo}/items/${itemId}/override`,
        { method: 'POST', body: JSON.stringify({ overridePriceSen, reason }) },
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order-detail', vars.docNo] });
    },
    onError: writeFailedAs('Price override not saved'),
  });
};

/* ── Payments ledger ─────────────────────────────────────────────────── */
export type ConsignmentPayment = {
  id: string;
  so_doc_no: string;
  paid_at: string;
  method: 'merchant' | 'transfer' | 'cash';
  merchant_provider: string | null;
  installment_months: number | null;
  online_type: string | null;
  approval_code: string | null;
  amount_centi: number;
  account_sheet: string | null;
  collected_by: string | null;
  collected_by_name: string | null;
  note: string | null;
  created_at: string;
  created_by: string | null;
};

export const useConsignmentOrderPayments = (docNo: string | null) => useQuery({
  queryKey: ['consignment-order', docNo, 'payments'],
  queryFn: () => authedFetch<{ payments: ConsignmentPayment[] }>(`/consignment-orders/${docNo}/payments`).then((r) => r.payments),
  enabled: Boolean(docNo),
  staleTime: 2 * 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* `idempotencyKey` — optional, destructured OUT of the body. See
   useAddSalesOrderPayment / lib/idempotency.ts for the one-key-per-intent rule. */
export const useAddConsignmentOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, idempotencyKey, ...body }: { docNo: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: ConsignmentPayment }>(`/consignment-orders/${docNo}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order', vars.docNo, 'payments'] });
      qc.invalidateQueries({ queryKey: ['consignment-order', vars.docNo] });
    },
  });
};

export const useDeleteConsignmentOrderPayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ docNo, id }: { docNo: string; id: string }) =>
      authedFetch<{ ok: boolean }>(`/consignment-orders/${docNo}/payments/${id}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-order', vars.docNo, 'payments'] });
      qc.invalidateQueries({ queryKey: ['consignment-order', vars.docNo] });
    },
    onError: writeFailedAs('Payment not deleted'),
  });
};

/* ── Debtor autocomplete ─────────────────────────────────────────────── */
export type DebtorSuggestion = {
  debtor_code: string | null;
  debtor_name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  address3: string | null;
  address4: string | null;
};
export const useConsignmentDebtorSearch = (q: string) => useQuery({
  queryKey: ['consignment-order', 'debtors', q],
  queryFn: ({ signal }) => authedFetch<{ debtors: DebtorSuggestion[] }>(
    `/consignment-orders/debtors/search${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    { signal },
  ),
  enabled: q.trim().length >= 2,
  staleTime: 5 * 60_000,
  retry: retryUnlessClientError,
});
