// ----------------------------------------------------------------------------
// Consignment Note query hooks — a faithful clone of the Delivery Order (mfg)
// hooks in flow-queries.ts, repointed at the parallel backend route mounted at
// `/consignment-notes` (which mirrors `/delivery-orders-mfg` 1:1: same create
// body, same detail shape, same line/payment endpoints).
//
// Numbering on the backend is `CN-YYMM-NNN`. The request/response types are
// intentionally kept identical to the DO hooks so the cloned ConsignmentNoteNew
// / ConsignmentNoteDetail / ConsignmentNotes pages can render exactly like the
// DO ones with only the endpoint + query key swapped.
//
// Query key namespace: ['consignment-note'] (+ '-detail') so consignment-note
// cache invalidation never collides with the DO cache.
//
// ── HOUZS VENDOR NOTES ──────────────────────────────────────────────────────
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The supabase import is dropped.
//   - serviceNotify maps to the vendored dialog-service serviceNotify.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── List ────────────────────────────────────────────────────────────── */
export const useConsignmentNotes = (status?: string) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-note', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryOrders: any[] }>(
    `/consignment-notes${status ? `?status=${status}` : ''}`,
  ),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── List (opt-in server-side pagination) ────────────────────────────────
   Sending `page` switches /consignment-notes into its paginated contract
   ({ deliveryOrders, total, page, pageSize }); the legacy useConsignmentNotes
   above (no page) still returns the historical unpaginated array. `q` searches
   do_number + debtor_name (columns the CN list already searches + in the header
   select). `sort` is 'col:dir' over
   { do_date, do_number, debtor_name, status, local_total_centi } (default
   do_date:desc). placeholderData keepPrevious so paging doesn't flash empty. */
/* Full-set money KPIs returned by the paginated CN list (mirrors the SO list
   `aggregates` contract) — summed over the SAME filters as the page.
   costCenti / marginCenti are FINANCE-ONLY: the server omits them for a
   non-finance caller (canViewScmFinance), so they are optional here and the
   Cost / Margin tiles are not rendered for such a viewer. */
export type ConsignmentNoteAggregates = { revenueCenti: number; costCenti?: number; marginCenti?: number };
export const useConsignmentNotesPaged = (params: {
  page: number;
  pageSize: number;
  status?: string;
  q?: string;
  sort?: string;
}) => {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery<{ deliveryOrders: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentNoteAggregates }>({
    queryKey: ['consignment-note', 'list-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: ({ signal }) => authedFetch<{ deliveryOrders: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentNoteAggregates }>(`/consignment-notes?${usp.toString()}`, { signal }),
    placeholderData: (prev: unknown) => prev as { deliveryOrders: unknown[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentNoteAggregates } | undefined,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
};

/* ── Detail ──────────────────────────────────────────────────────────── */
export const useConsignmentNoteDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-note-detail', id],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/consignment-notes/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* ── Deliverable Consignment Order lines (From-Order multi-picker) ────── */
export type DeliverableOrderLine = {
  orderItemId: string;
  orderDocNo: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  ordered: number;
  delivered: number;
  outstanding: number;
  unitPriceCenti: number;
  discountCenti: number;
  unitCostCenti: number;
  variants: unknown;
};

export const useDeliverableOrderLines = () => useQuery({
  queryKey: ['consignment-note', 'deliverable-order-lines'],
  queryFn: () => authedFetch<{ lines: DeliverableOrderLine[] }>(
    `/consignment-notes/deliverable-order-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── Create ──────────────────────────────────────────────────────────── */
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a note field. Pass one per note intent
   (see lib/idempotency.ts): the middleware replays the first response — the SAME
   doNumber — instead of consigning the goods twice. Omitting it is exactly
   today's behaviour (the middleware no-ops).

   Mirrors useAddConsignmentNotePayment below, idempotent since #657 while the
   note the payment hangs off was not. */
export const useCreateConsignmentNote = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; doNumber: string }>(
        `/consignment-notes`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consignment-note'] }),
  });
};

/* ── Status update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentNoteStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch(`/consignment-notes/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* ── Header update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentNoteHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-notes/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
  });
};

/* ── Line items ──────────────────────────────────────────────────────── */
export const useAddConsignmentNoteItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/consignment-notes/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
    },
  });
};

export const useUpdateConsignmentNoteItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-notes/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
    },
  });
};

export const useDeleteConsignmentNoteItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/consignment-notes/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-note'] });
    },
    onError: writeFailed,
  });
};

/* ── Payments ledger ─────────────────────────────────────────────────── */
export type ConsignmentNotePayment = {
  id: string;
  delivery_order_id: string;
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

export const useConsignmentNotePayments = (id: string | null) => useQuery({
  queryKey: ['consignment-note', id, 'payments'],
  queryFn: () => authedFetch<{ payments: ConsignmentNotePayment[] }>(`/consignment-notes/${id}/payments`).then((r) => r.payments),
  enabled: Boolean(id),
  staleTime: 2 * 60_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* `idempotencyKey` — optional, destructured OUT of the body. See
   useAddSalesOrderPayment / lib/idempotency.ts for the one-key-per-intent rule. */
export const useAddConsignmentNotePayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey, ...body }: { id: string; idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ payment: ConsignmentNotePayment }>(`/consignment-notes/${id}/payments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
  });
};

export const useDeleteConsignmentNotePayment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paymentId }: { id: string; paymentId: string }) =>
      authedFetch<{ ok: boolean }>(`/consignment-notes/${id}/payments/${paymentId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-note', vars.id, 'payments'] });
      qc.invalidateQueries({ queryKey: ['consignment-note-detail', vars.id] });
    },
  });
};
