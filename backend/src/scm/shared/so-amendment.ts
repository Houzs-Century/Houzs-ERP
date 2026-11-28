
export type AmendStatus = 'REQUESTED'|'SUPPLIER_PENDING'|'SO_APPROVED'|'PO_APPROVED'|'SENT'|'REJECTED';
export type AmendAction = 'supplier-confirm'|'approve-so'|'approve-po'|'send'|'reject'|'withdraw';

const FLOW: Record<AmendAction, { from: AmendStatus[]; to: AmendStatus }> = {
  'supplier-confirm': { from: ['REQUESTED'], to: 'SUPPLIER_PENDING' },
  'approve-so':       { from: ['SUPPLIER_PENDING','REQUESTED'], to: 'SO_APPROVED' },
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

export const actionTargetStatus = (a: AmendAction): AmendStatus => FLOW[a].to;

const FORWARD_RANK: Record<AmendStatus, number> = {
  REQUESTED: 0, SUPPLIER_PENDING: 1, SO_APPROVED: 2, PO_APPROVED: 3, SENT: 4, REJECTED: -1,
};

export function statusSatisfies(current: AmendStatus, target: AmendStatus): boolean {
  if (target === 'REJECTED') return current === 'REJECTED';
  if (current === 'REJECTED') return false;
  return FORWARD_RANK[current] >= FORWARD_RANK[target];
}

export const receivedFloorViolation = (
  line: { newQty: number | null }, po: { receivedQty: number },
): boolean => line.newQty != null && line.newQty < (po.receivedQty ?? 0);
