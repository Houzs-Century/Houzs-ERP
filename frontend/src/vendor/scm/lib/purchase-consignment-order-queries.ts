
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Currency,
  PoStatus,
  PoHeaderRow,
  PoItemRow,
  NewPoItem,
} from './suppliers-queries';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

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
      /** The product request this order is raised from (owner 2026-10-06); the
          server refuses one not APPROVED or without a SKU, and marks it
          PCO_ISSUED once the order stands (requestClaimed on the answer). */
      productRequestId?: string;
    }) =>
      authedFetch<{ id: string; pcNumber: string; poNumber?: string; productRequestId?: string; requestClaimed?: boolean | null }>(`/purchase-consignment-orders`,
        idempotentInit(idempotencyKey, {
          method: 'POST',
          body: JSON.stringify(body),
        })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pc-order'] }),
  });
}

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
    onError: writeFailed,
  });
}

/* ── Cancel (mirror PO) ───────────────────────────────────────────────
   A useDeletePurchaseConsignmentOrder used to sit below this, calling
   DELETE /purchase-consignment-orders/:id. Both the hook and the endpoint are
   gone (owner rule 2026-08-11: 不可以删只可以 cancel). CANCELLED is terminal
   and the record stays. */
export interface cancelPurchaseConsignmentOrderParameters {
  id: string,
  reason: string
}


export function useCancelPurchaseConsignmentOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({id, reason}: cancelPurchaseConsignmentOrderParameters) =>
      authedFetch<{ purchaseOrder: { id: string; status: PoStatus; cancelled_at: string; cancel_reason: string } }>(
        `/purchase-consignment-orders/${id}/cancel`,
        { method: 'PATCH', body: JSON.stringify({ cancel_reason: reason })}
      ),
    onSuccess: (_, {id}) => {
      qc.invalidateQueries({ queryKey: ['pc-order'] });
      qc.invalidateQueries({ queryKey: ['pc-order-detail', id] });
    },
  });
}
