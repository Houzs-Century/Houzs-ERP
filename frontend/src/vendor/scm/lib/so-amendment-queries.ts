// TanStack Query hooks for the SO-amendment / revision workflow (Phase 1-C).
//
// HOUZS VENDOR — verbatim port of 2990's apps/backend/src/lib/so-amendment-queries.ts.
// Import boundary only: authedFetch comes from the vendored './authed-fetch' (the
// same /api/scm mount every other SCM query module uses). The backend endpoints
// live on two mounts:
//   • /so-amendments               — list + detail + the gate PATCHes
//   • /mfg-sales-orders/:docNo/amendments — CREATE (nests under the SO mount so
//                                    it can reuse that file's SO guards).
//
// Every gate mutation invalidates the amendment list + detail AND the SO/PO
// list + detail queries the SalesOrderDetail / PurchaseOrderDetail pages read
// (invalidateSoLists — BOTH SO list keys — + ['mfg-sales-order-detail'] +
// ['mfg-purchase-orders'] + ['mfg-purchase-order-detail']) — an approve re-derives
// the SO and/or the bound PO server-side, so those pages must refetch to show the
// revised lines/revision.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { idempotentInit } from '../../../lib/idempotency';
import { invalidateSoLists } from './sales-order-queries';
import type { SoAmendmentHeaderChanges } from './so-amendment-header';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

/* ── Row + detail shapes (mirror the API response verbatim) ─────────────────
   List rows are loosely typed (accessors read by name), matching the GRN/SO
   list convention. */
export type AmendmentRow = {
  id: string;
  so_doc_no: string;
  amendment_no: number | string | null;
  status: string;
  reason: string | null;
  requested_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  /* mig 0149 — how the amendment was CLOSED and why. `resolution` separates an
     approver's refusal ('REJECTED') from the requester pulling it back
     ('WITHDRAWN'); both sit on status REJECTED so the state machine and the
     one-open index are unchanged. NULL while still in flight, and on every row
     created before 0149. */
  resolution?: 'REJECTED' | 'WITHDRAWN' | null;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  /* mig 0149 — an amendment corrected in place while still REQUESTED. The audit
     trail carries WHAT changed; this is the "revised since it was raised"
     signal the approver needs on the card itself. */
  edited_at?: string | null;
  edit_count?: number | null;
  /* Two-lane rework (2026-07-27, mig 0216): 'LINES' (product changes →
     Purchasing signs) | 'DELIVERY' (delivery/customer changes → Logistics
     signs). NULL on rows raised before the rework — those keep the legacy
     supplier-confirmed two-gate chain. */
  lane?: 'LINES' | 'DELIVERY' | string | null;
  /* Owner 2026-07-27 — the PO(s) this SO's lines were purchased on
     (purchase_order_items.so_item_id linkage, resolved by the list endpoint).
     The PO Amendments inbox merges rows with a bound PO alongside the direct
     po_amendments so purchasing sees the whole revision queue in one place.
     Empty on an SO with no purchase leg (and on responses from a pre-upgrade
     backend, so read it defensively). */
  bound_pos?: Array<{ id: string; po_number: string; status: string }>;
};

export type AmendmentLine = {
  id: string;
  amendment_id: string;
  sales_order_item_id: string | null;
  change_type: string;
  new_item_code: string | null;
  new_variants: unknown;
  new_qty: number | null;
  new_unit_price_sen: number | null;
  /* mig 0280 — the requested line REMARK (the operator's free-text instruction
     for whoever executes the line). null = the request does not touch it; ''
     = clear it. Absent on every row raised before 0280. */
  new_remark?: string | null;
  old_snapshot: unknown;
};

export type AmendmentDetail = {
  amendment: AmendmentRow & Record<string, unknown> & {
    /* mig 0119 — the HEADER half of the request (Delivery Date / Processing Date
       / State / Postcode: the columns the processing lock freezes) + the values
       they replace. NULL/absent on a line-only amendment. */
    header_changes?: SoAmendmentHeaderChanges | null;
    old_header_snapshot?: SoAmendmentHeaderChanges | null;
  };
  lines: AmendmentLine[];
  salesOrder: { doc_no: string; status: string; revision: number } | null;
  purchaseOrders: Array<{ id: string; po_number: string; status: string }>;
};

/* SO revision snapshot row — one per approved SO revision (so_revisions).
   `snapshot` is the full header+lines JSON captured when the amendment's
   approve-so gate re-derived the order; the Revisions tab renders it read-only. */
export type SoRevisionRow = {
  id: string;
  revision: number;
  snapshot: unknown;
  created_at: string | null;
  created_by: string | null;
};

/* Create payload — matches POST /mfg-sales-orders/:docNo/amendments. */
export type CreateAmendmentLine = {
  salesOrderItemId?: string;
  changeType: string;
  newItemCode?: string;
  newVariants?: unknown;
  newQty?: number;
  newUnitPriceSen?: number;
  /* mig 0280 — the line's REMARK. Omit when the request does not touch it; ''
     is a real request to clear it. Before 0280 this had no column and the
     submit dropped it in silence (owner 2026-08-11, 2990-SO-2608-016). */
  newRemark?: string;
  oldSnapshot?: unknown;
};

/* Shared invalidation for every gate mutation. An approve re-derives the SO
   header/lines and/or the bound PO(s) server-side, so the SO list + SO detail +
   PO list + PO detail queries (the exact keys SalesOrderDetail /
   PurchaseOrderDetail read via the vendored queries) must all refetch alongside
   the amendment list + detail. Broad (no id) invalidation is intentional — a
   gate can touch any bound PO and the row only carries the SO doc_no. */
const invalidateAmendmentSideEffects = (
  qc: ReturnType<typeof useQueryClient>,
  id?: string,
) => {
  qc.invalidateQueries({ queryKey: ['amendments'] });
  if (id) qc.invalidateQueries({ queryKey: ['amendment-detail', id] });
  /* An approve re-derives the SO's lines/revision, so its list row changes —
     and that means BOTH list keys (the V2 paged key is a sibling of
     ['mfg-sales-orders'], not nested under it). */
  invalidateSoLists(qc);
  qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail'] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-orders'] });
  qc.invalidateQueries({ queryKey: ['mfg-purchase-order-detail'] });
  /* Two-lane rework: a LINES-lane approve auto-raises follow-up rows in the PO
     Amendments module — its list must show them without a manual refresh. */
  qc.invalidateQueries({ queryKey: ['po-amendments'] });
  /* A gate writes one AMENDMENT_* audit row, and the amendment's Approval-history
     view reads the SO audit log — refetch it so the new decision shows at once
     (broad key: the gate carries the amendment id, not the SO doc_no here). */
  qc.invalidateQueries({ queryKey: ['mfg-sales-order-audit-log'] });
};

/* ── List ──────────────────────────────────────────────────────────────── */
export const useAmendments = () => useQuery({
  queryKey: ['amendments'],
  queryFn: () => authedFetch<{ amendments: AmendmentRow[] }>(`/so-amendments`),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Detail ────────────────────────────────────────────────────────────── */
export const useAmendmentDetail = (id: string | null) => useQuery({
  queryKey: ['amendment-detail', id],
  queryFn: () => authedFetch<AmendmentDetail>(`/so-amendments/${id}`),
  enabled: Boolean(id),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── SO revisions (nested under the SO mount) ──────────────────────────────
   GET /mfg-sales-orders/:docNo/revisions — the prior SO versions for the
   Detail "Revisions" tab. Read-only; no invalidation wiring needed. Keyed on
   the doc_no so it refetches only when the page's docNo changes. */
export const useSoRevisions = (docNo: string | null) => useQuery({
  queryKey: ['so-revisions', docNo],
  queryFn: () => authedFetch<{ revisions: SoRevisionRow[] }>(`/mfg-sales-orders/${docNo}/revisions`),
  enabled: Boolean(docNo),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── PO revisions (nested under the PO mount) ──────────────────────────────
   GET /mfg-purchase-orders/:id/revisions — the prior PO versions for the PO
   Detail "Revisions" tab. Read-only; no invalidation wiring needed. Keyed on
   the po id so it refetches only when the page's PO changes. Mirrors
   useSoRevisions; the row shape (po_revisions) matches SoRevisionRow. */
export const usePoRevisions = (poId: string | null) => useQuery({
  queryKey: ['po-revisions', poId],
  queryFn: () => authedFetch<{ revisions: SoRevisionRow[] }>(`/mfg-purchase-orders/${poId}/revisions`),
  enabled: Boolean(poId),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

/* ── Create (nested under the SO mount) ────────────────────────────────────
   POST /mfg-sales-orders/:docNo/amendments — the CREATE lives on the SO router
   so it can reuse the SO processing-lock / downstream guards. */
export const useCreateAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    /* `headerChanges` carries the FROZEN header fields (Delivery Date etc.) the
       processing lock refuses on a direct PATCH — without it those changes had
       nowhere to go and were silently dropped (Owner 2026-07-16). Optional: a
       line-only amendment omits it. The server 400s `amendment_empty` when both
       halves are empty, so a no-op submit can no longer create a blank
       amendment in the approval queue. */
    /* `idempotencyKey` is OPTIONAL and MUST be destructured out of the body —
       the rest-spread would otherwise post it as an amendment field. The
       amendment number is minted as `${docNo}/A${prior.length + 1}` (backend
       mfg-sales-orders.ts), the count+1 shape doc-no.ts warns about, so two
       in-flight submits can both read the same `prior.length`. The open-
       amendment 409 backstops the common case, but it is a check-then-act
       race, not a constraint — one key per amendment intent closes it. */
    mutationFn: ({ docNo, idempotencyKey, ...body }: {
      docNo: string;
      idempotencyKey?: string;
      reason?: string;
      lines: CreateAmendmentLine[];
      headerChanges?: SoAmendmentHeaderChanges;
    }) =>
      authedFetch<{ amendment: AmendmentRow }>(
        `/mfg-sales-orders/${docNo}/amendments`,
        idempotentInit(idempotencyKey, { method: 'POST', body: JSON.stringify(body) }),
      ),
    onSuccess: (_, vars) => {
      invalidateAmendmentSideEffects(qc);
      // The SO gains an open amendment → its detail flags (has_open_amendment,
      // amendment_eligible) flip. Refresh that specific SO detail immediately.
      qc.invalidateQueries({ queryKey: ['mfg-sales-order-detail', vars.docNo] });
    },
  });
};

/* ── Gate PATCHes ──────────────────────────────────────────────────────────
   Each records the supplier/coordinator action and advances the state machine
   server-side. On a wrong-state call the API 409s bad_transition, which
   authedFetch surfaces as a plain-language error. */
export const useSupplierConfirm = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; ref: string; note?: string; attachmentKey?: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/supplier-confirm`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useApproveSo = () => {
  const qc = useQueryClient();
  return useMutation({
    /* Two-lane rework: a LINES-lane approve also returns the follow-up PO
       Amendment(s) it auto-raised (+ any plain-language warnings) so the
       approver's toast can point at their next signature. */
    mutationFn: ({ id }: { id: string }) =>
      authedFetch<{
        amendment: AmendmentRow;
        revision: number;
        poFollowUps?: Array<{ poId: string; poNumber: string; amendmentId: string; amendmentNo: string }>;
        warnings?: string[];
      }>(`/so-amendments/${id}/approve-so`, { method: 'PATCH' }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

/* approve-po may 409 with { code:'received_floor', poItemId, revisedQty,
   receivedQty }. The raw body rides on the thrown error (err.body / err.status
   from authedFetch) so the caller can render the offending-line detail; a bare
   surface still reads as one plain sentence. */
export const useApprovePo = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      authedFetch<{
        amendment: AmendmentRow;
        revisedPurchaseOrders: Array<{ poNumber: string; revision: number }>;
        /* Plain-language notes about anything the reconciliation left for a human:
           an already-received removed line, an added item with no open PO, an
           emptied PO. Absent/empty on a clean revision. */
        warnings?: string[];
      }>(
        `/so-amendments/${id}/approve-po`, { method: 'PATCH' },
      ),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

export const useSendAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/send`, { method: 'PATCH' }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

/* Reject — an APPROVER refusing the request. The reason is REQUIRED (the server
   400s without one): a refusal that does not say why leaves the requester
   guessing and resubmitting, which is the competing-documents problem that
   useWithdrawAmendment / useEditAmendment exist to end. */
export const useRejectAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/reject`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

/* Withdraw — the REQUESTER pulling their own request back, which reject cannot
   express (reject is gated to scm.amendment.approve_po, which a salesperson does
   not hold). REQUESTED only; the server refuses once anyone has acted on it. */
export const useWithdrawAmendment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      authedFetch<{ amendment: AmendmentRow }>(`/so-amendments/${id}/withdraw`, {
        method: 'PATCH', body: JSON.stringify({ reason }),
      }),
    onSuccess: (_, vars) => invalidateAmendmentSideEffects(qc, vars.id),
  });
};

