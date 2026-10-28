// SO amendment / revision workflow — pure state machine + guards.
// Port of 2990 packages/shared/src/so-amendment.ts (shipped 2026-07-03).
//
// A supplier-confirmed, two-gate amendment revises a processing-locked SO and its
// bound PO in place. These are the pure transition rules the route handlers import
// (routes/so-amendments.ts) — no DB, no I/O, so client + server share them.

export type AmendStatus = 'REQUESTED'|'SUPPLIER_PENDING'|'SO_APPROVED'|'PO_APPROVED'|'SENT'|'REJECTED';
export type AmendAction = 'supplier-confirm'|'approve-so'|'approve-po'|'send'|'reject'|'withdraw';

const FLOW: Record<AmendAction, { from: AmendStatus[]; to: AmendStatus }> = {
  'supplier-confirm': { from: ['REQUESTED'], to: 'SUPPLIER_PENDING' },
  'approve-so':       { from: ['SUPPLIER_PENDING','REQUESTED'], to: 'SO_APPROVED' }, // no-PO light path may skip supplier-confirm
  'approve-po':       { from: ['SO_APPROVED'], to: 'PO_APPROVED' },
  'send':             { from: ['PO_APPROVED'], to: 'SENT' },
  'reject':           { from: ['REQUESTED','SUPPLIER_PENDING','SO_APPROVED','PO_APPROVED'], to: 'REJECTED' },
  /* Owner 2026-07-19 — the REQUESTER pulling their own request back, as opposed
     to an approver refusing it. Deliberately NOT a new status: it lands on the
     same terminal REJECTED, which is what releases uq_so_amendment_open so a
     corrected request can be raised. What distinguishes the two for a reader is
     so_amendments.resolution ('WITHDRAWN' vs 'REJECTED', mig 0149) and the audit
     action, not the state machine.

     REQUESTED only. Once an approver has engaged with it — supplier confirmed,
     or either gate approved — retracting it unilaterally would erase work
     somebody else did; from there the requester asks for a reject. */
  'withdraw':         { from: ['REQUESTED'], to: 'REJECTED' },
};


export const canTransition = (s: AmendStatus, a: AmendAction): boolean => FLOW[a].from.includes(s);
export const nextStatus = (s: AmendStatus, a: AmendAction): AmendStatus | null =>
  canTransition(s, a) ? FLOW[a].to : null;

// The status an action PRODUCES, independent of the current status. Each action
// has exactly one destination, so this is deterministic — which is why the
// amendment write-back command channel keys its idempotency hash on it
// (scm/lib/amendment-command.ts): the target is a property of the action, not of
// the (possibly stale) mirrored status the caller observed.
export const actionTargetStatus = (a: AmendAction): AmendStatus => FLOW[a].to;

// Monotonic rank of the forward flow, for the 409-converged read-back: after
// 2990 rejects a retried command with bad_transition, the dispatcher reads the
// amendment's real status and treats "at or past the target" as convergence.
// REJECTED is a terminal branch OFF this line, not a point on it, so it is not
// ranked here — reject convergence is an exact-match check on REJECTED.
const FORWARD_RANK: Record<AmendStatus, number> = {
  REQUESTED: 0, SUPPLIER_PENDING: 1, SO_APPROVED: 2, PO_APPROVED: 3, SENT: 4, REJECTED: -1,
};

// True when `current` means the command's intent is already satisfied. For
// reject: only an exact REJECTED counts. For a forward action: current must be
// on the forward line AND at or past the target (so approve-so converges whether
// 2990 is now SO_APPROVED, PO_APPROVED or SENT — someone carried it further).
export function statusSatisfies(current: AmendStatus, target: AmendStatus): boolean {
  if (target === 'REJECTED') return current === 'REJECTED';
  if (current === 'REJECTED') return false;
  return FORWARD_RANK[current] >= FORWARD_RANK[target];
}

export const receivedFloorViolation = (
  line: { newQty: number | null }, po: { receivedQty: number },
): boolean => line.newQty != null && line.newQty < (po.receivedQty ?? 0);
