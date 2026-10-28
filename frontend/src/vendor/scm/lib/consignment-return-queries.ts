// ----------------------------------------------------------------------------
// Consignment Return query hooks — a faithful clone of the Delivery Return
// hooks in flow-queries.ts, repointed at the parallel backend route mounted at
// `/consignment-returns` (which mirrors `/delivery-returns` 1:1: same create
// body, same detail shape, same line endpoints).
//
// Numbering on the backend is `CRN-YYMM-NNN`. The request/response types are
// intentionally kept identical to the DR hooks so the cloned ConsignmentReturnNew
// / ConsignmentReturnDetail / ConsignmentReturns pages can render exactly like
// the DR ones with only the endpoint + query key swapped.
//
// A consignment-note detail hook is re-exported here for the New page's
// ?fromNote prefill convenience (mirrors DeliveryReturnNew's ?fromDo). It points
// at the consignment-note detail route.
//
// Query key namespace: ['consignment-return'] (+ '-detail') so cache
// invalidation never collides with the DR cache.
//
// ── HOUZS VENDOR NOTES ──────────────────────────────────────────────────────
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The supabase import is dropped.
//   - serviceNotify maps to the vendored dialog-service serviceNotify (already
//     registered by <Scm2990Shell>).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceNotify } from './dialog-service';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── Consignment Note detail (for ?fromNote prefill on the New page) ───── */
export const useConsignmentNoteDetailForReturn = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-note-detail', id],
  queryFn: () => authedFetch<{ deliveryOrder: any; items: any[] }>(`/consignment-notes/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* ── List ────────────────────────────────────────────────────────────── */
export const useConsignmentReturns = (status?: string) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-return', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ deliveryReturns: any[] }>(
    `/consignment-returns${status ? `?status=${status}` : ''}`,
  ),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── List (opt-in server-side pagination) ────────────────────────────────
   Sending `page` switches /consignment-returns into its paginated contract
   ({ deliveryReturns, total, page, pageSize }); the legacy useConsignmentReturns
   above (no page) still returns the historical unpaginated array. `q` searches
   return_number + debtor_name (columns the CRN list already searches + in the
   header select). `sort` is 'col:dir' over
   { return_date, return_number, debtor_name, status, local_total_sen }
   (default return_date:desc). placeholderData keepPrevious so paging doesn't
   flash empty. */
/* Full-set money KPIs returned by the paginated CRN list (mirrors the SO list
   `aggregates` contract) — summed over the SAME filters as the page.
   costSen / marginSen are FINANCE-ONLY: the server omits them for a
   non-finance caller (canViewScmFinance), so they are optional here and the
   Cost / Margin tiles are not rendered for such a viewer. */
export type ConsignmentReturnAggregates = { revenueSen: number; costSen?: number; marginSen?: number };
export const useConsignmentReturnsPaged = (params: {
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
  return useQuery<{ deliveryReturns: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentReturnAggregates }>({
    queryKey: ['consignment-return', 'list-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queryFn: ({ signal }) => authedFetch<{ deliveryReturns: any[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentReturnAggregates }>(`/consignment-returns?${usp.toString()}`, { signal }),
    placeholderData: (prev: unknown) => prev as { deliveryReturns: unknown[]; total: number; page: number; pageSize: number; aggregates?: ConsignmentReturnAggregates } | undefined,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
};

/* ── Returnable Consignment Note lines (From-Note multi-picker) ────────── */
export type ReturnableNoteLine = {
  noteItemId: string;
  consignmentDoId: string;
  noteNumber: string;
  debtorCode: string | null;
  debtorName: string | null;
  itemCode: string;
  itemGroup: string | null;
  description: string | null;
  description2: string | null;
  uom: string | null;
  delivered: number;
  returned: number;
  remaining: number;
  unitPriceSen: number;
  discountSen: number;
  unitCostSen: number;
  variants: unknown;
};

export const useReturnableNoteLines = () => useQuery({
  queryKey: ['consignment-return', 'returnable-note-lines'],
  queryFn: () => authedFetch<{ lines: ReturnableNoteLine[] }>(
    `/consignment-returns/returnable-note-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── Detail ──────────────────────────────────────────────────────────── */
export const useConsignmentReturnDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['consignment-return-detail', id],
  queryFn: () => authedFetch<{ deliveryReturn: any; items: any[] }>(`/consignment-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* ── Create ──────────────────────────────────────────────────────────── */
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a return field. Pass one per return
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME returnNumber — instead of taking the consigned goods back twice.
   Omitting it is exactly today's behaviour (the middleware no-ops).

   NOT on fix/so-idempotency's list of remaining creates; same class as the rest,
   found by sweeping every create rather than re-reading that list. */
export const useCreateConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string }>(`/consignment-returns`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consignment-return'] }),
  });
};

/* ── Header update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-returns/${id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
    },
  });
};

/* ── Status update ───────────────────────────────────────────────────── */
export const useUpdateConsignmentReturnStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      authedFetch<{ deliveryReturn: unknown }>(`/consignment-returns/${id}/status`, {
        method: 'PATCH', body: JSON.stringify({ status }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Status update failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* ── Line items ──────────────────────────────────────────────────────── */
export const useAddConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...item }: { id: string } & Record<string, unknown>) =>
      authedFetch<{ item: unknown }>(`/consignment-returns/${id}/items`, {
        method: 'POST', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
  });
};

export const useUpdateConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...item }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: boolean }>(`/consignment-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(item),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
  });
};

export const useDeleteConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/consignment-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['consignment-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['consignment-return'] });
    },
    onError: writeFailed,
  });
};
