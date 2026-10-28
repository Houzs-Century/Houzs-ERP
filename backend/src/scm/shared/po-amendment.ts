// PO amendment workflow — pure state machine + guards.
//
// Sibling of so-amendment.ts, deliberately SIMPLER: the owner reduced the
// amendment lifecycle to a single request and a single approval. A PO amendment
// is REQUESTED, then either APPROVED (the approver applies it — snapshot + line
// diffs + revision bump + audit) or closed as REJECTED (an approver refuses it,
// or its requester withdraws it). There is NO supplier-pending / two-gate / sent
// chain here — that surfaced complexity was cut from the SO surface too.
//
// These are the pure transition rules the route handlers import
// (routes/po-amendments.ts) — no DB, no I/O, so client + server share them.

export type PoAmendStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED';
export type PoAmendAction = 'approve' | 'reject' | 'withdraw';

const FLOW: Record<PoAmendAction, { from: PoAmendStatus[]; to: PoAmendStatus }> = {
  // The single hard gate: applies the amendment to the PO and closes it APPROVED.
  'approve':  { from: ['REQUESTED'], to: 'APPROVED' },
  // An approver refusing the request — no document changes, closes REJECTED.
  'reject':   { from: ['REQUESTED'], to: 'REJECTED' },
  /* The REQUESTER pulling their own request back, as opposed to an approver
     refusing it (mirror of the SO withdraw, Owner 2026-07-19). Deliberately NOT a
     new status: it lands on the same terminal REJECTED, which is what releases
     uq_po_amendment_open so a corrected request can be raised. resolution =
     'WITHDRAWN' (mig 0192) is what tells a reader the two apart. */
  'withdraw': { from: ['REQUESTED'], to: 'REJECTED' },
};

export const canTransition = (s: PoAmendStatus, a: PoAmendAction): boolean => FLOW[a].from.includes(s);
export const nextStatus = (s: PoAmendStatus, a: PoAmendAction): PoAmendStatus | null =>
  canTransition(s, a) ? FLOW[a].to : null;

// The status an action PRODUCES, independent of the current status. Each action
// has exactly one destination.
export const actionTargetStatus = (a: PoAmendAction): PoAmendStatus => FLOW[a].to;

// A revised PO line qty must never drop below what has already been received —
// goods already in are not ours to un-receive. Mirror of so-amendment's floor.
export const poReceivedFloorViolation = (
  line: { newQty: number | null }, po: { receivedQty: number },
): boolean => line.newQty != null && line.newQty < (po.receivedQty ?? 0);
