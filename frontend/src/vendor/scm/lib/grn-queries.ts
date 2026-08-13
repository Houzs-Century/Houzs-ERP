// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — the GRN (Goods
// Received Note) query/mutation surface the vendored GRN pages call.
//
// The full source flow-queries.ts is ~1996 lines (the entire SO/DO/SI/PO/GRN/PI
// /return query surface + verified-save + supabase + serviceNotify). Only the
// GRN hooks are pulled here, copied VERBATIM except for the boundary:
//   • import { authedFetch } from './authed-fetch' (the repointed vendored fetch
import { writeFailed, writeFailedAs } from './mutation-error';
//     → /api/scm), instead of the source's relative './authed-fetch' that pulled
//     in supabase.
//   • the dropped `import { supabase }` / `verifiedSave` machinery — none of the
//     GRN hooks below reference it (they all go through authedFetch).
//   • serviceNotify (cancel onError toast) is the vendored dialog-service bridge.
//
// The picker hooks (useOutstandingPoItems / useCreateGrnsFromPoItems) already
// live in suppliers-queries.ts — NOT duplicated here; the from-PO page imports
// useOutstandingPoItems from there.

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── Batch conversions ────────────────────────────────────────────────
   BOTH hooks below have ZERO callers as of 2026-07-17 (verified across every
   .ts/.tsx under frontend/src). fix/so-idempotency listed them as un-migrated
   creates; they were NOT migrated by fix/doc-idempotency, deliberately. Adding
   an `idempotencyKey` param that no call site can pass would protect nobody
   while reading as coverage — that IS the disease this whole line of work is
   fixing (the mechanism ships, nobody opts in). Wire the param IN the PR that
   wires a caller, not before.

   The LIVE `/grns/from-pos` surface is mobile/MobileConvertWizard.tsx, which
   calls the endpoint through a bare authedFetch rather than this hook — that is
   where the key was actually added. `/purchase-returns/from-grns` has no live
   caller at all on either side.

   If either is ever wired, a per-mount key is the CORRECT shape and safe: the
   response types below say so — N purchaseOrderIds collapse into ONE grnNumber
   (poCount/lineCount are counts of SOURCES, not of documents raised), and N
   grnIds into ONE returnNumber. One request, one document, so a replay returns
   that one document. That is the opposite of SoFromProducts, which loops N
   REQUESTS and must never share a key. */
export const useGrnFromPos = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { purchaseOrderIds: string[]; deliveryNoteRef?: string; notes?: string }) =>
      authedFetch<{ id: string; grnNumber: string; poCount: number; lineCount: number }>(
        `/grns/from-pos`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
      /* Force picker refetch so received PO lines drop off. */
      qc.invalidateQueries({ queryKey: ['grns', 'outstanding-po-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('GRN not created'),
  });
};

export const usePurchaseReturnFromGrns = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { grnIds: string[]; reason?: string; notes?: string }) =>
      authedFetch<{ id: string; returnNumber: string; grnCount: number; lineCount: number }>(
        `/purchase-returns/from-grns`, { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      /* Force picker refetch so returned/invoiced GRN lines drop off. */
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('Purchase return not created'),
  });
};

/* ── GRN ─────────────────────────────────────────────────────────────── */
export const useGrns = (status?: string) =>
  useQuery({
    queryKey: ['grns', status ?? 'all'],
    queryFn: () => authedFetch<{ grns: any[] }>(`/grns${status ? `?status=${status}` : ''}`),
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });

// Opt-in server-side pagination + search + sort + status-counts (mirrors
// useMfgSalesOrdersPaged). Sending `page` switches /grns into its paginated
// contract ({ grns, total, page, pageSize, statusCounts }); the legacy useGrns
// above (no page) still returns the historical unpaginated list. `status` is
// the resolved grns.status DB value (UPPERCASE); each GRN filter-pill bucket
// (draft/posted/cancelled) maps 1:1 to a single DB status, so no bucket needs
// to be dropped here.
export function useGrnsPaged(params: { page: number; pageSize: number; status?: string; q?: string; sort?: string }) {
  const { page, pageSize, status, q, sort } = params;
  const usp = new URLSearchParams();
  usp.set('page', String(page));
  usp.set('pageSize', String(pageSize));
  if (status) usp.set('status', status);
  if (q && q.trim()) usp.set('q', q.trim());
  if (sort) usp.set('sort', sort);
  return useQuery({
    queryKey: ['grns-paged', page, pageSize, status ?? '', q ?? '', sort ?? ''],
    queryFn: ({ signal }) => authedFetch<{ grns: any[]; total: number; page: number; pageSize: number; statusCounts: { all: number; draft: number; posted: number; cancelled: number } }>(`/grns?${usp.toString()}`, { signal }),
    placeholderData: (prev: any) => prev,
    staleTime: 30_000,
    retry: retryUnlessClientError,
    retryDelay: 800,
  });
}
export const useGrnDetail = (id: string | null) => useQuery({
  queryKey: ['grn-detail', id],
  queryFn: () => authedFetch<{ grn: any; items: any[] }>(`/grns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* Several notes at once — ONE supplier invoice may bill SEVERAL goods-received
   notes (owner 2026-08-06), so the PI review screen needs every picked note's
   lines, not just the primary's. Same query key + options as useGrnDetail, so a
   note already fetched singly is served from that cache. */
export const useGrnDetails = (ids: string[]) => useQueries({
  queries: ids.map((id) => ({
    queryKey: ['grn-detail', id],
    queryFn: () => authedFetch<{ grn: any; items: any[] }>(`/grns/${id}`),
    staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
  })),
});
/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a GRN field. Pass one per GRN intent
   (see lib/idempotency.ts): the middleware replays the first response — the SAME
   grnNumber — instead of receiving the same goods twice. Omitting it is exactly
   today's behaviour (the middleware no-ops).

   Like suppliers-queries.ts, this file carried NO idempotency at all before
   2026-07-17 (fix/doc-idempotency). A duplicate GRN books stock IN twice and
   rolls the PO's received qty up twice — the on-hand lie the owner would only
   meet at a stock count. */
export const useCreateGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; grnNumber: string }>(`/grns`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['grns'] }),
  });
};
/* Confirm a DRAFT GRN → POSTED (PATCH /grns/:id/post). This is the commit
   chokepoint: the server runs postGrnAndRollup here (inventory IN + PO
   received-rollup). Also used right after a non-draft create as an idempotent
   no-op (the row is already POSTED). Invalidates the GRN detail + list +
   inventory so the page + on-hand reflect the just-committed receipt. */
export const usePostGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/grns/${id}/post`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

/* ── GRN PO-clone CRUD (mirror the PO header + line item hooks) ─────────────
   PATCH /grns/:id (header), POST/PATCH/DELETE /grns/:id/items[/:itemId].
   Each invalidates the GRN detail (['grn-detail', id]) + list (['grns']) —
   the same query keys useGrnDetail + useGrns read. */
export const useUpdateGrnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; receivedAt?: string; deliveryNoteRef?: string;
      warehouseId?: string; notes?: string; currency?: string;
    }) => authedFetch<{ grn: any }>(`/grns/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};

export const useAddGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, ...body }: { grnId: string } & Record<string, unknown>) =>
      authedFetch<{ item: any }>(`/grns/${grnId}/items`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};

export const useUpdateGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId, ...body }: { grnId: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true }>(`/grns/${grnId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
  });
};

export const useDeleteGrnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, itemId }: { grnId: string; itemId: string }) =>
      authedFetch<void>(`/grns/${grnId}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', vars.grnId] });
      qc.invalidateQueries({ queryKey: ['grns'] });
    },
    onError: writeFailed,
  });
};

/* ── Cancel a GRN (mirror useCancelPurchaseOrder) ──────────────────────────
   PATCH /grns/:id/cancel — server flips status → CANCELLED and reverses the
   receipt (inventory OUT + PO received_qty decrement). Invalidates the GRN
   detail + list + inventory so the on-hand drilldown reflects the reversal. */
export const useCancelGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch<{ grn: any }>(`/grns/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['grn-detail', id] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel GRN failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* ── Single-GRN conversions (GRN list right-click) ─────────────────────────
   POST /purchase-invoices/from-grn + /purchase-returns/from-grn take { grnId }
   and return the created doc's { id } so the caller can navigate straight in. */
export const usePurchaseInvoiceFromGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grnId: string) =>
      authedFetch<{ id: string; invoiceNumber: string }>(`/purchase-invoices/from-grn`, {
        method: 'POST', body: JSON.stringify({ grnId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-invoices'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      /* Force picker refetch so already-invoiced GRN lines drop off. */
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('Purchase invoice not created'),
  });
};

/* The arg widened from a bare `grnId: string` to an object on 2026-07-17 so a
   key could travel with it — the bare string was the whole reason
   fix/doc-idempotency deferred this one. `idempotencyKey` is OPTIONAL and is NOT
   part of the body (the body is built explicitly here, so there is no rest-spread
   to leak it as a document field).

   WHAT THE KEY IS FOR, and it is not the case the deferral assumed. This is a
   context-menu action on a LIST row (GoodsReceived.tsx) with NO pending guard —
   no disabled state, no spinner, no visual feedback of any kind. The premise
   under the other 17 ("the mechanism is NOT the double-tap — every form disables
   on submit") is simply FALSE here, so BOTH halves are live: the double-tap AND
   the retry after an apparent failure. Two in-flight posts each read
   remaining = qty_accepted - returned_qty BEFORE either has written, so both
   copy the full remaining and both create a PR — stock OUT twice and the refund
   booked twice. adjustGrnReturnedQty then CLAMPS returned_qty to qty_accepted
   (purchase-returns.ts:126), so the GRN reads "fully returned" while twice the
   goods left. The clamp hides the duplicate from every downstream gate; on-hand
   is the only witness, at the next stock count.

   WHY per-GRN IS safe here, given more than one return per GRN IS valid.
   purchase-returns.ts:806-807 is explicit — "a GRN can be returned across
   multiple PRs (0106)" — so a key bound to the grnId FOREVER would swallow a
   real second return, which is worse than the duplicate. It is not bound
   forever. /from-grn always copies ALL remaining and drains returned_qty to
   qty_accepted (:873-876), so the ONLY way to reach a legitimate second return
   is to trim PR-1 first, which RELEASES the qty (:1270) — and trimming means
   opening the PR, i.e. leaving the list. The caller's ref dies with that mount
   and the next visit mints a fresh key, so the second return runs for real.
   Within ONE mount, two clicks on the SAME GRN are always one intent.

   The sequential retry is already domain-guarded (the second post finds
   remaining = 0 and 400s "GRN is fully returned"), so the key does not save the
   document there — it upgrades a confusing 400 into a replay of the original
   201, landing the operator on the PR that actually exists. The duplicate it
   genuinely PREVENTS is the concurrent one above. */
export const usePurchaseReturnFromGrn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ grnId, idempotencyKey }: { grnId: string; idempotencyKey?: string }) =>
      authedFetch<{ id: string; returnNumber: string }>(`/purchase-returns/from-grn`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify({ grnId }),
        })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['grns'] });
      /* Force picker refetch so returned GRN lines drop off. */
      qc.invalidateQueries({ queryKey: ['purchase-invoices', 'outstanding-grn-items'], refetchType: 'all' });
    },
    onError: writeFailedAs('Purchase return not created'),
  });
};
