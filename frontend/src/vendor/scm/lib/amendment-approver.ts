// ----------------------------------------------------------------------------
// Who signs an amendment — the ONE word and colour for it, on every surface.
//
// Owner 2026-09-14: 「purchaser / logistic - approver需要更明显得看 - 那个是归类
// purchaser哪个是归类Logistic」. The words are the ROLE names the approve keys are
// granted to (mig 0216: Purchaser -> scm.amendment.approve_lines +
// scm.po_amendment.approve; Logistic -> scm.amendment.approve_delivery), so staff
// read the badge as "mine" or "not mine". Before this the SO queue printed grey
// "Purchasing" / "Logistics", the PO queue and the phone printed nothing, and the
// detail pages spelled it a third way in sentences.
//
// An SO amendment follows its lane (backend/src/scm/shared/amendment-lane.ts); a
// lane-NULL row predates the two-lane rework and keeps the legacy chain. A PO
// amendment has ONE approve key, and Purchaser is the role that holds it.
// ----------------------------------------------------------------------------

export type AmendmentApprover = 'PURCHASER' | 'LOGISTIC' | 'LEGACY';

export function soAmendmentApprover(lane: string | null | undefined): AmendmentApprover {
  if (lane === 'LINES') return 'PURCHASER';
  if (lane === 'DELIVERY') return 'LOGISTIC';
  return 'LEGACY';
}

export const PO_AMENDMENT_APPROVER: AmendmentApprover = 'PURCHASER';

export const AMENDMENT_APPROVER_LABEL: Record<AmendmentApprover, string> = {
  PURCHASER: 'Purchaser',
  LOGISTIC: 'Logistic',
  LEGACY: 'Legacy',
};

/* Not a status tone on purpose: Requested / Approved / Rejected already own the
   burnt, green and red pills on the desktop row, and the phone paints Requested
   teal — so Purchaser is a clear blue, not a blue-grey that reads as teal on a
   small card. The approver must not read as a fourth status. */
export const AMENDMENT_APPROVER_TONE: Record<AmendmentApprover, { bg: string; fg: string }> = {
  PURCHASER: { bg: 'rgba(53, 82, 163, 0.14)', fg: '#3552a3' },
  LOGISTIC: { bg: 'rgba(123, 63, 120, 0.14)', fg: '#7b3f78' },
  LEGACY: { bg: 'rgba(34, 31, 32, 0.08)', fg: '#6b6f66' },
};
