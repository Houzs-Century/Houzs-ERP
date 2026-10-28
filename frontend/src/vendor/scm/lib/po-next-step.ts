// ----------------------------------------------------------------------------
// po-next-step — what a Purchase Order may do next, and why it may not yet, in
// ONE place. The purchase-side twin of do-next-step.ts, written for the same
// reason and to the same rule: a control the state forbids stays on screen,
// disabled, carrying the sentence that says why and what to do instead.
//
// ── THE BUG THAT MADE THIS URGENT ───────────────────────────────────────────
// The read-only Purchase Order page carried a "Submit" button on every DRAFT PO
// and it could never work. It called PATCH /mfg-purchase-orders/:id/submit,
// whose handler (mfg-purchase-orders.ts:4046) reads the row, echoes when the PO
// is already SUBMITTED, 409s on a missing warehouse — and then returns
//
//     { error: 'cannot_submit', message: `PO is ${row.status}` }, 409
//
// unconditionally. There is no `.update(...)` anywhere in it. A DRAFT PO
// therefore always failed, and because the frontend surfaces the server's own
// sentence verbatim, the operator was told "That change was not saved — PO is
// DRAFT" in answer to "submit this draft". The file's own create-path comment
// had already recorded the endpoint as abandoned: "PATCH /submit stays an
// idempotent no-op for legacy callers" (:1307).
//
// Meanwhile /confirm — the handler that actually writes DRAFT → SUBMITTED,
// stamps submitted_at and advances the source SO quota — was reachable from the
// EDIT view and from the phone, but not from the page the route lands on
// (App.tsx:616 mounts PurchaseOrderDetailV2 for /scm/purchase-orders/:id). Four
// controls advanced a draft PO; three used /confirm and the fourth, the one the
// operator actually meets, used the dead one. That is "我又不是两套系统" in its
// most literal form — the same system, refusing on one screen what it performs
// on another.
//
// The second half of the same defect: "Confirm" was rendered only when the PO
// was ALREADY SUBMITTED, where /confirm is an explicit idempotent echo
// (:4086 "an already-live PO is already confirmed, echo back"). So the pair read
// as a system where Submit always fails and Confirm always succeeds without
// doing anything. Both predicates were inverted relative to their endpoints.
//
// ── THE VOCABULARY (verified, not assumed) ──────────────────────────────────
//   DRAFT, SUBMITTED, PARTIALLY_RECEIVED, RECEIVED, CANCELLED
// — the PoStatus union in vendor/scm/lib/suppliers-queries.ts:24.
//
// What the server enforces, read from routes/:
//   · /confirm writes only from DRAFT; SUBMITTED and PARTIALLY_RECEIVED echo;
//     anything else is 409 cannot_confirm (mfg-purchase-orders.ts:4086-4092).
//   · Goods may be received only against SUBMITTED or PARTIALLY_RECEIVED —
//     RECEIVABLE_PO_STATUSES in routes/grns.ts:200.
//   · /reopen takes a CANCELLED PO to SUBMITTED, not to DRAFT (:4514), and
//     refuses outright when the cancel already reached AutoCount (:4487).
//
// A status this module does not recognise gets the GENERIC sentence, never a
// guess. Naming a step that does not exist is worse than saying the state is
// unexpected — see the COMPLETED story in backend/src/scm/shared/
// do-shipped-states.ts for what a confidently-asserted status costs.
//
// SCOPE. "Why not yet", never "may this user". Permission still hides.
// ----------------------------------------------------------------------------

/** Statuses a Goods Receipt can be raised from — mirrors RECEIVABLE_PO_STATUSES. */
export const GRN_RECEIVABLE_PO_STATUSES = ['submitted', 'partially_received'] as const;

function norm(status: string | null | undefined): string {
  return String(status ?? '').trim().toLowerCase();
}

/**
 * `null` when this PO can be confirmed (DRAFT → SUBMITTED via PATCH /confirm).
 * Otherwise the sentence for the disabled control.
 */
export function poConfirmBlockReason(status: string | null | undefined): string | null {
  const s = norm(status);
  if (s === 'draft') return null;
  if (s === 'submitted' || s === 'partially_received') {
    return 'This purchase order is already confirmed and live with the supplier.';
  }
  if (s === 'received') {
    return 'This purchase order is marked fully received, so confirming no longer applies to it.';
  }
  if (s === 'cancelled') {
    /* Reopen goes to SUBMITTED, not back to DRAFT (mfg-purchase-orders.ts:4514),
       so the honest next step is "reopen it", not "confirm it again". Note the
       server refuses even that when the cancel reached AutoCount (:4487); the
       refusal carries its own sentence and the caller surfaces it. */
    return 'This purchase order was cancelled. Reopen it to make it live again.';
  }
  return 'Only a draft purchase order can be confirmed.';
}

/**
 * `null` when a Goods Receipt can be raised from this PO. Otherwise the sentence
 * for the disabled control.
 */
export function grnTransferBlockReason(status: string | null | undefined): string | null {
  const s = norm(status);
  if ((GRN_RECEIVABLE_PO_STATUSES as readonly string[]).includes(s)) return null;
  if (s === 'draft') {
    return 'Confirm this purchase order first — goods can only be received against a confirmed PO.';
  }
  if (s === 'received') {
    /* Deliberately states the HEADER FLAG, not a conclusion about the lines.
       routes/unbilled-deliveries.ts:13-21 is the cautionary case: a header
       status flag was read as "this was billed" and turned out to measure only
       whether somebody clicked it, wrong in both directions. The transfer is
       blocked here because RECEIVED is not in RECEIVABLE_PO_STATUSES — that is
       the fact, and it is the one worth saying. */
    return 'This purchase order is marked fully received, so no further goods can be received against it.';
  }
  if (s === 'cancelled') {
    return 'This purchase order was cancelled, so no goods can be received against it.';
  }
  return 'Goods can only be received against a confirmed purchase order.';
}
