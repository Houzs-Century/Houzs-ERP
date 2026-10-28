// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — only the Purchase
// Return read + mutation hooks the PR list / detail / new pages call. The full
// source flow-queries module (~1996 lines, the whole SO/DO/SI/PO/GRN/PI/return
// surface + verified-save + supabase + serviceNotify wiring) is not pulled in.
//
// HOUZS VENDOR NOTES:
//   • supabase is never referenced by these hooks (all reads/writes go through
//     authedFetch → /api/scm) so the source `import { supabase }` is DROPPED.
//   • useCancelPurchaseReturn's onError raised serviceNotify in the source; that
//     bridge is already vendored (lib/dialog-service) and registered by
//     <Scm2990Shell>, so it's kept verbatim.
//   • Hooks are copied verbatim, including their query keys
//     (['purchase-returns'] / ['purchase-return-detail', id]) so list + detail
//     invalidation stays identical to the source.
//   • DIVERGENCE from the source: the hooks whose route writes inventory_movements
//     (create / cancel / line edit + delete) also invalidate ['inventory']. The
//     source never did, so a PR left every stock view stale until staleTime —
//     the same defect 2990 carries. Port back rather than re-dropping on sync.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed, writeFailedAs } from './mutation-error';
import { idempotentInit } from '../../../lib/idempotency';
import { serviceNotify } from './dialog-service';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── movementErrors: a SUCCESS that moved no stock ─────────────────────────
   Every purchase-return write that touches inventory answers with the document
   AND an optional `movementErrors: string[]` — the return is saved, the stock
   write was refused (writeMovements never throws, it returns { ok:false }). The
   HTTP status is a success, so `onError` never fires and the operator sees
   nothing unless a success handler looks. That silence is the defect this
   surfaces; the write itself deliberately stands, because an edit must not be
   rolled back for a ledger hiccup.

   Raised here, in the shared hook layer, rather than per page: these hooks are
   the only thing desktop and mobile would both call, and a warning that lives in
   one page is a warning the other surface does not have. */
type WithMovementErrors = { movementErrors?: string[] };

const reportMovementErrors = (title: string, res: WithMovementErrors | undefined | void): void => {
  const errs = res?.movementErrors;
  if (!errs?.length) return;
  writeFailedAs(title)(new Error(
    `${errs.join('\n')}\n\n` +
    'The document is saved. Stock was NOT adjusted for this change — tell IT so the ledger can be repaired.',
  ));
};

/* ── Purchase Returns ────────────────────────────────────────────────── */
export const usePurchaseReturns = (status?: string) =>
  useQuery({
    queryKey: ['purchase-returns', status ?? 'all'],
    queryFn: () => authedFetch<{ purchaseReturns: any[] }>(
      `/purchase-returns${status ? `?status=${status}` : ''}`,
    ),
    staleTime: 30_000,
    retry: retryUnlessClientError,
  });

export const usePurchaseReturnDetail = (id: string | null) => useQuery({
  queryKey: ['purchase-return-detail', id],
  queryFn: () => authedFetch<{ purchaseReturn: any; items: any[] }>(`/purchase-returns/${id}`),
  enabled: Boolean(id), staleTime: 30_000, retry: retryUnlessClientError, retryDelay: 800,
});

/* The pool a PO-sourced return draws from (2026-08-21): the PO's POSTED GRN
   lines with remaining (accepted − returned) > 0, each carrying its grnItemId
   so the created return is capped, consumes the receipt, and deducts the
   RECEIVING warehouse — not the company default. HOUZS-only addition (no
   source twin yet); port to 2990 with the page that reads it. */
export type ReturnableGrnLine = {
  grnItemId: string; grnNumber: string | null; materialKind: string | null;
  itemCode: string; materialName: string | null; itemGroup: string | null;
  variants: Record<string, unknown> | null; unitPriceSen: number;
  rejectionReason: string | null; remaining: number;
};
export const useReturnableGrnLines = (poId: string | null) => useQuery({
  queryKey: ['pr-returnable-grn-lines', poId],
  queryFn: () => authedFetch<{ lines: ReturnableGrnLine[]; supplierId: string | null }>(
    `/purchase-returns/returnable-grn-lines?poId=${encodeURIComponent(poId as string)}`,
  ),
  enabled: Boolean(poId), staleTime: 15_000, retry: retryUnlessClientError,
});

/* `idempotencyKey` is OPTIONAL and must be destructured OUT of the body — the
   rest-spread would otherwise post it as a return field. Pass one per return
   intent (see lib/idempotency.ts): the middleware replays the first response —
   the SAME returnNumber — instead of returning the goods twice. Omitting it is
   exactly today's behaviour (the middleware no-ops).

   Load-bearing here in particular: as the onSuccess note below records, this
   POST creates the return ALREADY POSTED and writes the stock OUT inline, so a
   duplicate does not sit harmlessly as a draft — it moves stock a second time. */
export const useCreatePurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: { idempotencyKey?: string } & Record<string, unknown>) =>
      authedFetch<{ id: string; returnNumber: string } & WithMovementErrors>(`/purchase-returns`,
        idempotentInit(idempotencyKey, {
          method: 'POST', body: JSON.stringify(body),
        })),
    onSuccess: (data) => {
      // The route has returned movementErrors since it was written; nothing read
      // it, so a return whose stock OUT was refused still reported "created".
      reportMovementErrors('Return created, but stock did not move', data);
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      /* PR-DRAFT-removal: the POST creates the return already POSTED and writes
         the stock OUT inline, so a create moves stock. (The route's own header
         comment still says "create draft" — the /post handler's does not.) */
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });
};

export const usePostPurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-returns/${id}/post`, { method: 'PATCH' }),
    /* No ['inventory'] here: post-DRAFT-removal this route is a backward-compat
       no-op — it 200s an already-POSTED return WITHOUT re-writing movements
       (that would double-debit) or 409s. The create already moved the stock. */
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', id] });
    },
  });
};

export const useCompletePurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, creditNoteRef }: { id: string; creditNoteRef?: string }) =>
      authedFetch(`/purchase-returns/${id}/complete`, {
        method: 'PATCH', body: JSON.stringify({ creditNoteRef }),
      }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
    },
    onError: writeFailed,
  });
};

export const useCancelPurchaseReturn = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => authedFetch(`/purchase-returns/${id}/cancel`, { method: 'PATCH' }),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', id] });
      // Cancel REVERSES this return's stock OUT (an opposite IN per bucket).
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (err) => {
      serviceNotify({ title: 'Cancel return failed', body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });
    },
  });
};

/* ── PR PO-clone CRUD (mirror the GRN header + line item hooks) ─────────────
   PATCH /purchase-returns/:id (header), POST/PATCH/DELETE
   /purchase-returns/:id/items[/:itemId]. Each invalidates the PR detail
   (['purchase-return-detail', id]) + list (['purchase-returns']) — the same
   query keys usePurchaseReturnDetail + usePurchaseReturns read. The LINE hooks
   additionally bump ['inventory']: on an already-POSTED return the backend posts
   the qty delta as a movement. The header hook does not — it moves no stock. */
export const useUpdatePurchaseReturnHeader = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: {
      id: string; supplierId?: string; returnDate?: string; reason?: string;
      creditNoteRef?: string; notes?: string;
    }) => authedFetch<{ purchaseReturn: any }>(`/purchase-returns/${id}`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
    },
    onError: writeFailed,
  });
};

export const useUpdatePurchaseReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId, ...body }: { id: string; itemId: string } & Record<string, unknown>) =>
      authedFetch<{ ok: true } & WithMovementErrors>(`/purchase-returns/${id}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (data, vars) => {
      reportMovementErrors('Line saved, but stock did not move', data);
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      // Editing a line posts the qty DELTA as a movement on a POSTED return.
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailed,
  });
};

export const useDeletePurchaseReturnItem = () => {
  const qc = useQueryClient();
  return useMutation({
    /* 200 `{ ok, movementErrors? }`, not the old 204: a 204 cannot carry the
       reversal failure at all. authedFetch parses the JSON body the same way it
       returned undefined for the 204, so the only change here is the type. */
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) =>
      authedFetch<{ ok: true } & WithMovementErrors>(`/purchase-returns/${id}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (data, vars) => {
      reportMovementErrors('Line deleted, but stock did not come back', data);
      qc.invalidateQueries({ queryKey: ['purchase-return-detail', vars.id] });
      qc.invalidateQueries({ queryKey: ['purchase-returns'] });
      // Dropping a line reverses that line's stock OUT via a delta movement.
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: writeFailedAs('Line not deleted'),
  });
};
