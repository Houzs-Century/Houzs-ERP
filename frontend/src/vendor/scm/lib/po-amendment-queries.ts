// TanStack Query hooks for the PO-amendment / revision workflow (Houzs, mig 0192).
//
// The PO-side sibling of so-amendment-queries.ts, built to the owner's SIMPLIFIED
// single-approver model: an amendment is one request and one approval. Unlike the
// SO amendment there is NO supplier-confirm / two-gate / send chain — the state
// machine is REQUESTED -> APPROVED, with REJECTED the terminal close for both a
// rejection and a withdrawal.
//
// The whole surface lives on ONE mount (unlike SO, whose CREATE nests under the
// SO router): /api/scm/po-amendments — list + detail + create + the gate PATCHes.
//
// Every gate mutation invalidates the amendment list + detail AND the PO list +
// detail queries the PurchaseOrderDetail / PO-list pages read (the PO queries live
// in suppliers-queries.ts under ['mfg-purchase-orders'] / ['mfg-purchase-order-detail'])
// — an approve re-derives the PO server-side, so those pages must refetch to show
// the revised lines / revision.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import type { AmendmentFieldKind } from './amendment-routing';

/* ── Row + detail shapes (mirror the API response verbatim) ─────────────────
   List rows are loosely typed (accessors read by name), matching the SO
   amendment / GRN / PO list convention. */
export type PoAmendmentRow = {
  id: string;
  po_id: string;
  po_number: string;
  amendment_no: number | string | null;
  status: string;
  reason: string | null;
  requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  /* How the amendment was CLOSED and why. `resolution` separates an approver's
     refusal ('REJECTED') from the requester pulling it back ('WITHDRAWN'); both
     sit on status REJECTED so the state machine and the one-open index are
     unchanged. NULL while still in flight. */
  resolution?: 'REJECTED' | 'WITHDRAWN' | null;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  edited_at?: string | null;
  edit_count?: number | null;
};

/* PO amendment line — new_* carries the requested value, old_snapshot the value
   it replaces. Prices are in centi (1/100 MYR), the PO convention. */
export type PoAmendmentLine = {
  id: string;
  amendment_id: string;
  purchase_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_material_name: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  new_delivery_date: string | null;
  old_snapshot: unknown;
};

/* The field ATOMS a PO amendment line moves — the input to amendment-routing's
   classifier (shared by the PO desktop detail + the mobile detail so both label a
   changed row with the SAME responsible department). ADD / REMOVE is a whole-line
   change (LINE); otherwise one atom per new_* field that differs from the snapshot. */
export const poLineFieldKinds = (l: PoAmendmentLine): AmendmentFieldKind[] => {
  if (l.change_type === 'ADD' || l.change_type === 'REMOVE') return ['LINE'];
  const old = (l.old_snapshot as { item_code?: string | null; qty?: number | null; unit_price_sen?: number | null; delivery_date?: string | null } | null) ?? {};
  const kinds: AmendmentFieldKind[] = [];
  if (l.new_item_code != null && l.new_item_code !== (old.item_code ?? null)) kinds.push('SPEC');
  if (l.new_qty != null && l.new_qty !== (old.qty ?? null)) kinds.push('QTY');
  if (l.new_unit_price_sen != null && l.new_unit_price_sen !== (old.unit_price_sen ?? null)) kinds.push('PRICE');
  if (l.new_delivery_date != null && l.new_delivery_date !== (old.delivery_date ?? null)) kinds.push('DELIVERY');
  return kinds;
};

/* Header change half — the trust boundary AMENDABLE_HEADER in the backend
   (supplier_id / expected_at / notes) paired with the values it replaces. */
export type PoAmendmentHeaderChanges = Record<string, string | null>;

/** Route a PO header change key to its field atom (supplier -> SUPPLIER, delivery
    date -> DELIVERY). `notes` is not routable. */
export const poHeaderFieldKind = (key: string): AmendmentFieldKind | null =>
  key === 'supplier_id' ? 'SUPPLIER' : key === 'expected_at' ? 'DELIVERY' : null;

export type PoAmendmentDetail = {
  amendment: PoAmendmentRow & Record<string, unknown> & {
    approved_by?: string | null;
    approved_at?: string | null;
    header_changes?: PoAmendmentHeaderChanges | null;
    old_header_snapshot?: PoAmendmentHeaderChanges | null;
  };
  lines: PoAmendmentLine[];
  purchaseOrder: {
    id: string;
    po_number: string;
    status: string;
    revision: number;
    supplier_id?: string | null;
    expected_at?: string | null;
  } | null;
};

/* Create payload line — matches POST /po-amendments body.lines[]. */
export type CreatePoAmendmentLine = {
  purchaseOrderItemId?: string | null;
  changeType: string;
  newMaterialCode?: string | null;
  newMaterialName?: string | null;
  newVariants?: unknown;
  newQty?: number | null;
  newUnitPriceSen?: number | null;
  newDeliveryDate?: string | null;
  oldSnapshot?: unknown;
};

/* Shared invalidation for every gate mutation. An approve re-derives the PO
   header/lines and bumps its revision server-side, so the PO list + PO detail
   queries (the keys PurchaseOrdersListV2 / PurchaseOrderDetailV2 read via the
   vendored suppliers-queries) must refetch alongside the amendment list + detail. */
const invalidatePoAmendmentSideEffects = (
  qc: ReturnType<typeof useQueryClient>,
  id?: string,
  poId?: string,
) => {
  qc.invalidateQueries({ queryKey: ['po-amendments'] });
  if (id) qc.invalidateQueries({ queryKey: ['po-amendment-detail', id] });
  /* Broad PO invalidation — both the plain and paged list keys, plus every PO
     detail. An approve rewrites the one PO the amendment targets and bumps its
     revision. */
  qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-orders-paged'] });
  if (poId) qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail', poId] });
  else qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail'] });
  /* The PO revisions tab reads po_revisions; an approve snapshots one. */
  qc.invalidateQueries({ queryKey: ['po-revisions'] });
};

/* ── List ──────────────────────────────────────────────────────────────── */
export const usePoAmendments = () => useQuery({
  queryKey: ['po-amendments'],
  queryFn: () => authedFetch<{ amendments: PoAmendmentRow[] }>(`/po-amendments`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Detail ────────────────────────────────────────────────────────────── */
export const usePoAmendmentDetail = (id: string | null) => useQuery({
  queryKey: ['po-amendment-detail', id],
  queryFn: () => authedFetch<PoAmendmentDetail>(`/po-amendments/${id}`),
  enabled: Boolean(id),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Create ────────────────────────────────────────────────────────────────
   POST /po-amendments — body { poId, reason?, headerChanges?, lines[] }. The
   server 400s `amendment_empty` when both the header and line halves are empty,
   409s `amendment_already_open` when a REQUESTED amendment already exists on the
   PO. An idempotency key closes the count+1 amendment-no race (see the SO note). */
export const useCreatePoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ idempotencyKey, ...body }: {
      poId: string;
      idempotencyKey?: string;
      reason?: string;
      headerChanges?: PoAmendmentHeaderChanges;
      lines: CreatePoAmendmentLine[];
    }) =>
      authedFetch<{ amendment: PoAmendmentRow }>(
        `/po-amendments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, undefined, vars.poId),
  });
};

/* ── Gate PATCHes ──────────────────────────────────────────────────────────
   Each advances the state machine server-side. On a wrong-state call the API
   409s bad_transition, which authedFetch surfaces as a plain-language error. */

/* approve may 409 with { code:'received_floor', poItemId, revisedQty,
   receivedQty }. The raw body rides on the thrown error (err.body / err.status
   from authedFetch) so the caller can render the offending-line detail. */
export const useApprovePoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; poId?: string }) =>
      authedFetch<{
        amendment: PoAmendmentRow;
        revision: number;
        /* Plain-language notes about anything the reconciliation left for a human:
           an already-received removed line preserved, etc. Absent/empty on clean. */
        warnings?: string[];
      }>(`/po-amendments/${id}/approve`, { method: 'PATCH' }),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, vars.id, vars.poId),
  });
};

/* Reject — an APPROVER refusing the request. The reason is REQUIRED (the server
   400s without one): a refusal that does not say why leaves the requester
   guessing and resubmitting. */
export const useRejectPoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string; poId?: string }) =>
      authedFetch<{
        amendment: PoAmendmentRow;
        /* Rejecting a FOLLOW-UP (raised by an SO revision) means the supplier
           will not follow the revision, so the server auto-releases the affected
           lines' un-allocated qty to STOCK and reports it here (owner rule,
           2026-08-06: the spec mismatch is a fact, not a decision). */
        releasedToStock?: Array<{ poItemId: string; itemCode: string; qty: number }>;
        releaseWarnings?: string[];
      }>(`/po-amendments/${id}/reject`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, vars.id, vars.poId),
  });
};

/* Withdraw — the REQUESTER pulling their own request back. REQUESTED only; the
   server refuses once anyone has acted on it. Reason optional. */
export const useWithdrawPoAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string; poId?: string }) =>
      authedFetch<{ amendment: PoAmendmentRow }>(`/po-amendments/${id}/withdraw`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidatePoAmendmentSideEffects(qc, vars.id, vars.poId),
  });
};
