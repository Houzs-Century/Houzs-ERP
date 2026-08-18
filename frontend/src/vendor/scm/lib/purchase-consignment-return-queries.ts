// ----------------------------------------------------------------------------
// Purchase Consignment Return query hooks — a faithful clone of the Purchase
// Return hooks in flow-queries.ts, repointed at the parallel backend route
// mounted at `/purchase-consignment-returns` (which mirrors `/purchase-returns`
// 1:1: same create body, same detail shape, same header + line item endpoints).
//
// Numbering on the backend is `PCT-…`. The request/response shapes are kept
// identical to the PR hooks so the cloned PurchaseConsignmentReturnNew /
// PurchaseConsignmentReturnDetail / PurchaseConsignmentReturns pages render
// exactly like the PR ones with only the endpoint + query key swapped.
//
// Query key namespace: ['pc-return'] (+ '-detail') so purchase-consignment
// cache invalidation never collides with the PR cache.
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
export const usePurchaseConsignmentReturns = (status?: string) => useQuery({
  queryKey: ['pc-return', 'list', status ?? 'all'],
  queryFn: () => authedFetch<{ purchaseReturns: any[] }>(`/purchase-consignment-returns${status ? `?status=${status}` : ''}`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Detail ──────────────────────────────────────────────────────────── */
export const usePurchaseConsignmentReturnDetail = (id: string | null) => useQuery({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryKey: ['pc-return-detail', id],
  queryFn: () => authedFetch<{ purchaseReturn: any; items: any[] }>(`/purchase-consignment-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* ── Returnable PC Receive lines (From-Receive multi-picker) ──────────── */
export type ReturnablePcReceiveLine = {
  receiveItemId: string;
  pcReceiveId: string;
  receiveNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  materialKind: string;
  materialCode: string;
  materialName: string;
  itemGroup: string | null;
  description: string | null;
  uom: string | null;
  accepted: number;
  returned: number;
  remaining: number;
  unitPriceSen: number;
  variants: unknown;
};

export const useReturnablePcReceiveLines = () => useQuery({
  queryKey: ['pc-return', 'returnable-receive-lines'],
  queryFn: () => authedFetch<{ lines: ReturnablePcReceiveLine[] }>(
    `/purchase-consignment-returns/returnable-receive-lines`,
  ).then((r) => r.lines),
  staleTime: 30_000,
  retry: retryUnlessClientError,
});

/* ── Create + post ───────────────────────────────────────────────────── */
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a return field. Pass one per return
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME returnNumber — instead of returning the consigned goods twice.
   Omitting it is exactly today's behaviour (the middleware no-ops). */
export const useCreatePurchaseConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string }>(`/purchase-consignment-returns`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify(body),
        })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pc-return'] }),
  });
};

export const usePostPurchaseConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-consignment-returns/${id}/post`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['pc-return'] });
      qc.invalidateQueries({ queryKey: ['pc-return-detail', id] });
    },
  });
};

export const useCancelPurchaseConsignmentReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-consignment-returns/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['pc-return'] });
      qc.invalidateQueries({ queryKey: ['pc-return-detail', id] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel return failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* ── Header update ───────────────────────────────────────────────────── */
export const useUpdatePurchaseConsignmentReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; returnDate?: string; reason?: string;
      creditNoteRef?: string; notes?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) => authedFetch<{ purchaseReturn: any }>(`/purchase-consignment-returns/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-return'] });
    },
  });
};

/* ── Line items ──────────────────────────────────────────────────────── */
export const useUpdatePurchaseConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true }>(`/purchase-consignment-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-return'] });
    },
  });
};

export const useDeletePurchaseConsignmentReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<void>(`/purchase-consignment-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['pc-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['pc-return'] });
    },
    onError: writeFailed,
  });
};
