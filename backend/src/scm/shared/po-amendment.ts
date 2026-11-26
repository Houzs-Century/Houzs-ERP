
export type PoAmendStatus = 'REQUESTED' | 'APPROVED' | 'REJECTED';
export type PoAmendAction = 'approve' | 'reject' | 'withdraw';

const FLOW: Record<PoAmendAction, { from: PoAmendStatus[]; to: PoAmendStatus }> = {
  'approve':  { from: ['REQUESTED'], to: 'APPROVED' },
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

export const actionTargetStatus = (a: PoAmendAction): PoAmendStatus => FLOW[a].to;

export const poReceivedFloorViolation = (
  line: { newQty: number | null }, po: { receivedQty: number },
): boolean => line.newQty != null && line.newQty < (po.receivedQty ?? 0);
