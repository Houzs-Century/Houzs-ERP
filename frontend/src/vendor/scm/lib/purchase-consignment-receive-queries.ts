// ----------------------------------------------------------------------------
// Purchase Consignment Receive query hooks — a faithful clone of the GRN hooks
// in flow-queries.ts, repointed at the parallel backend route mounted at
// `/purchase-consignment-receives` (which mirrors `/grns` 1:1: same create body,
// same detail shape, same header + line item endpoints).
//
// Numbering on the backend is `PCR-…`. The request/response shapes are kept
// identical to the GRN hooks so the cloned PurchaseConsignmentReceiveNew /
// PurchaseConsignmentReceiveDetail / PurchaseConsignmentReceives pages render
// exactly like the GRN ones with only the endpoint + query key swapped.
//
// Query key namespace: ['pc-receive'] (+ '-detail') so purchase-consignment
// cache invalidation never collides with the GRN cache.
//
// ── HOUZS VENDOR NOTES ──────────────────────────────────────────────────────
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The supabase import is dropped (it was unused by
//     these hooks anyway — every call already went through authedFetch).
//   - serviceNotify is the vendored dialog bridge (in-app notify, no window.*).
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceNotify } from './dialog-service';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── List ────────────────────────────────────────────────────────────── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const usePurchaseConsignmentReceives = (status?: string) => useQuery({
  queryKey: ['pc-receive', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ grns: any[] }>(`/purchase-consignment-receives${status ? `?status=${status}` : ''}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Detail ──────────────────────────────────────────────────────────── */
export const usePurchaseConsignmentReceiveDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['pc-receive-detail', id],
  queryFn: () => authedFetch<{ grn: any; items: any[] }>(`/purchase-consignment-receives/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* ── Outstanding PC Order lines (From-Order multi-picker) ─────────────── */
export type OutstandingPcOrderLine = {
  orderItemId: string;
  purchaseConsignmentOrderId: string;
  pcNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  materialKind: string;
  materialCode: string;
  materialName: string;
  supplierSku: string | null;
  itemGroup: string | null;
  description: string | null;
  uom: string | null;
  ordered: number;
  received: number;
  outstanding: number;
  unitPriceCenti: number;
  variants: unknown;
};

export const useOutstandingPcOrderLines = () => useQuery({
  queryKey: ['pc-receive', 'outstanding-order-lines'],
  queryFn: () => authedFetch<{ lines: OutstandingPcOrderLine[] }>(
    `/purchase-consignment-receives/outstanding-order-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── Create + post ───────────────────────────────────────────────────── */
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a receive field. Pass one per receive
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME grnNumber — instead of receiving the consigned goods twice. Omitting
   it is exactly today's behaviour (the middleware no-ops). */
export const useCreatePurchaseConsignmentReceive = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; grnNumber: string }>(`/purchase-consignment-receives`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pc-receive'] }),
  });
};

export const usePostPurchaseConsignmentReceive = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-consignment-receives/${id}/post`, { method: 'PATCH' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pc-receive'] }),
  });
};

/* ── Header update ───────────────────────────────────────────────────── */
export const useUpdatePurchaseConsignmentReceiveHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; receivedAt?: string; deliveryNoteRef?: string;
      warehouseId?: string; notes?: string; currency?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => authedFetch<{ grn: any }>(`/purchase-consignment-receives/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-receive-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-receive'] });
    },
  });
};

/* ── Line items ──────────────────────────────────────────────────────── */
export const useAddPurchaseConsignmentReceiveItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, ...body }: { grnId: string } & Record<string, unknown>) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authedFetch<{ item: any }>(`/purchase-consignment-receives/${grnId}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-receive-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['pc-receive'] });
    },
  });
};

export const useUpdatePurchaseConsignmentReceiveItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId, ...body }: { grnId: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true }>(`/purchase-consignment-receives/${grnId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-receive-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['pc-receive'] });
    },
  });
};

export const useDeletePurchaseConsignmentReceiveItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId }: { grnId: string; itemId: string }) =>
      authedFetch<void>(`/purchase-consignment-receives/${grnId}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-receive-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['pc-receive'] });
    },
    onError: writeFailed,
  });
};

/* ── Cancel (mirror GRN) ─────────────────────────────────────────────── */
export const useCancelPurchaseConsignmentReceive = () => {
  const qc = useQueryClient();
  return useMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mutationFn: (id: string) => authedFetch<{ grn: any }>(`/purchase-consignment-receives/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['pc-receive-detail', id] });
      qc.invalidateQueries({ queryKey: ['pc-receive'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel receive failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};
