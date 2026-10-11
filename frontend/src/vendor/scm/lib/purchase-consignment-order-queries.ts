// ----------------------------------------------------------------------------
// Purchase Consignment Order query hooks — a faithful clone of the Purchase
// Order hooks in suppliers-queries.ts, repointed at the parallel backend route
// mounted at `/purchase-consignment-orders` (which mirrors `/mfg-purchase-orders`
// 1:1: same create body, same detail shape, same line item endpoints).
//
// Numbering on the backend is `PCO-…`. The request/response types are kept
// identical to the PO hooks so the cloned PurchaseConsignmentOrderNew /
// PurchaseConsignmentOrderDetail / PurchaseConsignmentOrders pages can render
// exactly like the PO ones with only the endpoint + query key swapped.
//
// Query key namespace: ['pc-order'] (+ '-detail') so purchase-consignment cache
// invalidation never collides with the PO cache.
//
// ── HOUZS VENDOR NOTES ──────────────────────────────────────────────────────
//   - All reads/writes route through the vendored authedFetch (→ /api/scm/...),
//     NOT 2990's supabase REST. The supabase import is dropped (it was unused by
//     these hooks anyway — every call already went through authedFetch).
//   - Shared PO row/body types are reused from the vendored suppliers-queries.
// ----------------------------------------------------------------------------

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Currency,
  PoStatus,
  PoHeaderRow,
  PoItemRow,
  NewPoItem,
} from './suppliers-queries';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── List ────────────────────────────────────────────────────────────── */
export function usePurchaseConsignmentOrders(opts?: { status?: PoStatus; supplierId?: string }) {
  return useQuery({
    queryKey: ['pc-order', 'list', opts?.status ?? 'all', opts?.supplierId ?? 'all'],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (opts?.status) params.set('status', opts.status);
      if (opts?.supplierId) params.set('supplierId', opts.supplierId);
      const res = await authedFetch<{ purchaseOrders: PoHeaderRow[] }>(
        `/purchase-consignment-orders${params.toString() ? `?${params.toString()}` : ''}`,
      );
      return res.purchaseOrders;
    },
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

/* ── Detail ──────────────────────────────────────────────────────────── */
export function usePurchaseConsignmentOrderDetail(id: string | null) {
  return useQuery({
    queryKey: ['pc-order-detail', id],
    queryFn: () => authedFetch<{ purchaseOrder: PoHeaderRow; items: PoItemRow[] }>(`/purchase-consignment-orders/${id}`),
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}

/* ── Create ──────────────────────────────────────────────────────────── */
/* `idempotencyKey` is OPTIONAL and is destructured OUT of the body — the
   rest-spread would otherwise post it as an order field. Pass one per order
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME poNumber — instead of committing the company to the consignment
   twice. Omitting it is exactly today's behaviour (the middleware no-ops).

   NOT on fix/so-idempotency's list of remaining creates (it named the PC Receive
   and PC Return but not the ORDER those two hang off), and covered here for the
   same reason the SO was: the source document is the one that must not double.
   The omission is itself the pattern — the list was written by reading the
   files, and this hook lives in a file of its own. */
export function useCreatePurchaseConsignmentOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: {
      idempotencyKey?: string;
      supplierId: string;
      currency?: Currency;
      poDate?: string;
      expectedAt?: string;
      notes?: string;
      items?: NewPoItem[];
      purchaseLocationId?: string | null;
    }) =>
      authedFetch<{ id: string; poNumber: string }>(`/purchase-consignment-orders`,
        idempotentInit(idempotencyKey, {
          method: 'POST',
          body: JSON.stringify(body),
        })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pc-order'] }),
  });
}

/* ── Header update ───────────────────────────────────────────────────── */
export function useUpdatePurchaseConsignmentOrderHeader() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; poDate?: string; expectedAt?: string;
      currency?: Currency; notes?: string; supplierId?: string;
      purchaseLocationId?: string | null;
    }) => authedFetch<{ purchaseOrder: PoHeaderRow }>(`/purchase-consignment-orders/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-order-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-order'] });
    },
  });
}

/* ── Line items ──────────────────────────────────────────────────────── */
export function useAddPurchaseConsignmentOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, ...body }: NewPoItem & { poId: string }) =>
      authedFetch<{ item: PoItemRow }>(`/purchase-consignment-orders/${poId}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-order-detail', vars.poId] });
      qc.invalidateQueries({ queryKey: ['pc-order'] });
    },
  });
}

export function useUpdatePurchaseConsignmentOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId, ...body }: Partial<NewPoItem> & { poId: string; itemId: string }) =>
      authedFetch<{ ok: true }>(`/purchase-consignment-orders/${poId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-order-detail', vars.poId] });
      qc.invalidateQueries({ queryKey: ['pc-order'] });
    },
  });
}

export function useDeletePurchaseConsignmentOrderItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, itemId }: { poId: string; itemId: string }) =>
      authedFetch<void>(`/purchase-consignment-orders/${poId}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-order-detail', vars.poId] });
      qc.invalidateQueries({ queryKey: ['pc-order'] });
    },
  });
}

/* ── Cancel (mirror PO) ───────────────────────────────────────────────
   A useDeletePurchaseConsignmentOrder used to sit below this, calling
   DELETE /purchase-consignment-orders/:id. Both the hook and the endpoint are
   gone (owner rule 2026-08-11: 不可以删只可以 cancel). CANCELLED is terminal
   and the record stays. */
export function useCancelPurchaseConsignmentOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      authedFetch<{ purchaseOrder: { id: string; status: PoStatus; cancelled_at: string } }>(
        `/purchase-consignment-orders/${id}/cancel`,
        { method: 'PATCH' },
      ),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['pc-order'] });
      qc.invalidateQueries({ queryKey: ['pc-order-detail', id] });
    },
  });
}
