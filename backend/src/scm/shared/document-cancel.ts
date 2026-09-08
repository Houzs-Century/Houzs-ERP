// Document cancellation approval — pure state machine + guards.
//
// THE OWNER, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」.
// Cancelling a Sales Order or a Purchase Order is no longer one click. The
// person who wants it cancelled writes a REASON and raises a request; a level-1
// approver signs; a level-2 approver signs; only then may the document's
// existing cancel route run. Two signatures, two different people, neither of
// them the requester.
//
// This file is the RULES and nothing else — no DB, no I/O — so the route
// handlers (routes/document-cancel-routes.ts), the execution guard in front of
// the two cancel endpoints, and the tests all read the same table. The
// notification service (services/cancelRequestNotify.ts) holds the permission
// keys as literals rather than importing this file (a Houzs-side service must
// not pull the SCM bundle in); its test asserts the two tables agree.
//
// WHY A REQUEST ROW AND NOT A STATUS. `PENDING_CANCEL` on the document would be
// an enum value Postgres can never drop, would turn the document's status
// column into a laundry (so-lifecycle-guards.ts documents exactly how ON_HOLD
// became one), and could not remember a refused request beside the next one.
// A request is a row in scm.document_cancel_requests; the document's status is
// never touched until the cancel itself runs.

export type CancelDocType = 'SO' | 'PO';

export type CancelRequestStatus =
  | 'REQUESTED'    // raised, waiting for level 1
  | 'L1_APPROVED'  // level 1 signed, waiting for level 2
  | 'APPROVED'     // both signatures on it — the cancel may now run
  | 'EXECUTED'     // the document was cancelled (stamped by the cancel guard)
  | 'REJECTED'     // an approver refused it
  | 'WITHDRAWN';   // the requester pulled it back

/** A request that still blocks a second one and still shows on the document. */
export const OPEN_CANCEL_STATUSES: readonly CancelRequestStatus[] = ['REQUESTED', 'L1_APPROVED', 'APPROVED'];

export const isOpenCancelStatus = (s: string | null | undefined): boolean =>
  OPEN_CANCEL_STATUSES.includes(String(s ?? '') as CancelRequestStatus);

export type ApprovalLevel = 1 | 2;

/** The permission key that signs each level, per document. Declared in
 *  services/permissions.ts; Owner + IT Admin + Managing Director pass via `*`,
 *  everyone else through the Roles matrix. */
export const CANCEL_APPROVE_KEY: Record<CancelDocType, Record<ApprovalLevel, string>> = {
  SO: { 1: 'scm.so_cancel.approve_l1', 2: 'scm.so_cancel.approve_l2' },
  PO: { 1: 'scm.po_cancel.approve_l1', 2: 'scm.po_cancel.approve_l2' },
};

/** Which signature a request is waiting for; null when it is not waiting. */
export function pendingLevel(status: string | null | undefined): ApprovalLevel | null {
  if (status === 'REQUESTED') return 1;
  if (status === 'L1_APPROVED') return 2;
  return null;
}

export function statusAfterApproval(level: ApprovalLevel): CancelRequestStatus {
  return level === 1 ? 'L1_APPROVED' : 'APPROVED';
}

/** What the document shows while the request is open: "1 of 2" style. */
export function signaturesGiven(status: string | null | undefined): number {
  if (status === 'REQUESTED') return 0;
  if (status === 'L1_APPROVED') return 1;
  if (status === 'APPROVED' || status === 'EXECUTED') return 2;
  return 0;
}

/* ── The reason ──────────────────────────────────────────────────────────── */

export const MIN_REASON_CHARS = 5;
export const MAX_REASON_CHARS = 1000;

export type Refusal = { error: string; message: string };

/** The requester's (or the rejecting approver's) words. Mandatory and bounded:
 *  a cancel with no reason is what this whole flow exists to refuse, and a
 *  2000-character paste would make the notice card unreadable. */
export function readReason(v: unknown): { ok: true; reason: string } | { ok: false; refusal: Refusal } {
  const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (text.length < MIN_REASON_CHARS) {
    return { ok: false, refusal: { error: 'reason_required', message: `Give a reason the approvers can act on — at least ${MIN_REASON_CHARS} characters.` } };
  }
  if (text.length > MAX_REASON_CHARS) {
    return { ok: false, refusal: { error: 'reason_too_long', message: `Reason too long (${MAX_REASON_CHARS} characters max).` } };
  }
  return { ok: true, reason: text };
}

/* ── Can this document be asked about at all? ────────────────────────────── */

/** A DRAFT is discarded, not cancelled (the SO deletes it; the PO's draft cancel
 *  commits nothing to anyone) — so a draft needs no approval and no request.
 *  Everything else that is not already terminal needs the two signatures. */
export function cancelNeedsApproval(docType: CancelDocType, docStatus: string | null | undefined): boolean {
  const s = String(docStatus ?? '').toUpperCase();
  if (s === 'DRAFT') return false;
  return true;
}

/** Why a request cannot be raised against this document right now. */
export function cancelRequestRefusal(docType: CancelDocType, docStatus: string | null | undefined): Refusal | null {
  const s = String(docStatus ?? '').toUpperCase();
  const noun = docType === 'SO' ? 'sales order' : 'purchase order';
  if (s === 'CANCELLED') return { error: 'already_cancelled', message: `This ${noun} is already cancelled.` };
  if (s === 'CLOSED') return { error: 'closed', message: `A closed ${noun} cannot be cancelled.` };
  if (s === 'RECEIVED') return { error: 'cannot_cancel', message: 'A fully received purchase order cannot be cancelled.' };
  if (s === 'DRAFT') {
    return docType === 'SO'
      ? { error: 'draft_is_discarded', message: 'A draft sales order is discarded, not cancelled — use Discard draft.' }
      : { error: 'draft_needs_no_approval', message: 'A draft purchase order can be cancelled directly — it needs no approval.' };
  }
  return null;
}

/* ── Who may do what to an open request ──────────────────────────────────── */

export type Signer = {
  /** public.users.id of the REAL caller. */
  userId: number | null | undefined;
  /** `hasHouzsPerm(c, key)` — true for the `*` wildcard too. */
  holds: (perm: string) => boolean;
};

export type CancelRequestLike = {
  doc_type: string;
  status: string;
  requested_by: number | null;
  l1_by?: number | null;
};

export type GateRefusal = Refusal & { httpStatus: 403 | 409 };

const same = (a: number | null | undefined, b: number | null | undefined): boolean =>
  a != null && b != null && Number(a) === Number(b);

/** Refuse an approve, or return the level it will sign. Two people, neither the
 *  requester: the level-2 signer may not be the level-1 signer, and nobody signs
 *  their own request — a wildcard grant does not lift either rule. */
export function approvalRefusal(req: CancelRequestLike, signer: Signer): { level: ApprovalLevel } | { refusal: GateRefusal } {
  const level = pendingLevel(req.status);
  if (level == null) {
    return { refusal: { httpStatus: 409, error: 'not_pending', message: `This request is ${req.status.toLowerCase().replace('_', ' ')} and is not waiting for a signature.` } };
  }
  if (same(signer.userId, req.requested_by)) {
    return { refusal: { httpStatus: 403, error: 'self_approval', message: 'You raised this request — someone else has to approve it.' } };
  }
  if (level === 2 && same(signer.userId, req.l1_by)) {
    return { refusal: { httpStatus: 403, error: 'same_signer', message: 'You already gave the level-1 approval — level 2 must be a different person.' } };
  }
  const key = approveKeyFor(req.doc_type, level);
  if (!key || !signer.holds(key)) {
    return { refusal: { httpStatus: 403, error: 'approve_forbidden', message: `You do not have permission to give the level-${level} approval for cancelling this ${req.doc_type === 'SO' ? 'sales order' : 'purchase order'}.` } };
  }
  return { level };
}

/** Either approver desk may refuse, while a signature is still pending. */
export function rejectRefusal(req: CancelRequestLike, signer: Signer): GateRefusal | null {
  if (pendingLevel(req.status) == null) {
    return { httpStatus: 409, error: 'not_pending', message: 'This request is no longer waiting for approval.' };
  }
  if (!holdsAnyApproveKey(req.doc_type, signer)) {
    return { httpStatus: 403, error: 'reject_forbidden', message: 'Only a cancellation approver can reject this request.' };
  }
  return null;
}

/** The requester may pull an open request back at any point before the cancel
 *  runs — including after both signatures, if they changed their mind. An
 *  approver may also close it on their behalf. */
export function withdrawRefusal(req: CancelRequestLike, signer: Signer): GateRefusal | null {
  if (!isOpenCancelStatus(req.status)) {
    return { httpStatus: 409, error: 'not_open', message: 'This request is already closed.' };
  }
  if (!same(signer.userId, req.requested_by) && !holdsAnyApproveKey(req.doc_type, signer)) {
    return { httpStatus: 403, error: 'withdraw_forbidden', message: 'Only the person who raised this request, or an approver, can withdraw it.' };
  }
  return null;
}

/** The key for a level, or null when `docType` is not one of ours — a row with
 *  an unknown doc_type must fail closed, not index past the table. */
export function approveKeyFor(docType: string, level: ApprovalLevel): string | null {
  return docType === 'SO' || docType === 'PO' ? CANCEL_APPROVE_KEY[docType][level] : null;
}

export function holdsAnyApproveKey(docType: string, signer: Pick<Signer, 'holds'>): boolean {
  const l1 = approveKeyFor(docType, 1);
  const l2 = approveKeyFor(docType, 2);
  return (l1 != null && signer.holds(l1)) || (l2 != null && signer.holds(l2));
}

/* ── The gate in front of the cancel itself ──────────────────────────────── */

/** Why the existing cancel route may not run yet. `open` is the document's open
 *  request, or null when there is none. Null answer = the cancel may proceed. */
export function executionRefusal(open: { status: string } | null | undefined): Refusal | null {
  if (!open) {
    return { error: 'cancel_approval_required', message: 'Cancelling needs two approvals first — request the cancellation and give a reason.' };
  }
  if (open.status === 'APPROVED') return null;
  const given = signaturesGiven(open.status);
  return {
    error: 'cancel_approval_required',
    message: `Cancelling needs two approvals first (${given} of 2 given).`,
  };
}
