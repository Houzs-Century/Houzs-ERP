/* The rules behind cancelling a Sales Order / Purchase Order. A SALES ORDER
 * takes a reason and then two signatures by two different people, neither of
 * them the requester (owner 2026-09-08). A PURCHASE ORDER takes the reason and
 * NOTHING else (owner 2026-09-09:「PO cancelled 不需要审批，只需要 remark 原因取消」)
 * — so every rule below that counts signatures has to say ZERO for it, and no
 * key may sign one. These are the pure rules the routes and the guard read; the
 * routes suite proves they are wired, this one proves what they say. */
import { describe, expect, it } from 'vitest';
import {
  CANCEL_APPROVE_KEY,
  approvalRefusal,
  cancelNeedsApproval,
  cancelRequestRefusal,
  executionRefusal,
  holdsAnyApproveKey,
  isOpenCancelStatus,
  isReasonOnly,
  levelsFor,
  pendingLevel,
  readReason,
  rejectRefusal,
  signaturesGiven,
  statusAfterApproval,
  withdrawRefusal,
  type Signer,
} from './document-cancel';

const signer = (userId: number, perms: string[]): Signer => ({
  userId,
  holds: (p) => perms.includes('*') || perms.includes(p),
});

const req = (over: Partial<{ doc_type: string; status: string; requested_by: number | null; l1_by: number | null }> = {}) => ({
  doc_type: 'SO',
  status: 'REQUESTED',
  requested_by: 1,
  l1_by: null,
  ...over,
});

describe('the reason', () => {
  it('is mandatory and at least a few words', () => {
    expect(readReason(undefined)).toMatchObject({ ok: false, refusal: { error: 'reason_required' } });
    expect(readReason('   ')).toMatchObject({ ok: false });
    expect(readReason('abc')).toMatchObject({ ok: false, refusal: { error: 'reason_required' } });
  });
  it('is flattened and bounded', () => {
    expect(readReason('  customer   changed\n\nmind  ')).toEqual({ ok: true, reason: 'customer changed mind' });
    expect(readReason('x'.repeat(1001))).toMatchObject({ ok: false, refusal: { error: 'reason_too_long' } });
  });
});

describe('the ladder', () => {
  it('waits for level 1, then level 2, then nothing', () => {
    expect(pendingLevel('REQUESTED')).toBe(1);
    expect(pendingLevel('L1_APPROVED')).toBe(2);
    expect(pendingLevel('APPROVED')).toBeNull();
    expect(pendingLevel('EXECUTED')).toBeNull();
    expect(pendingLevel('REJECTED')).toBeNull();
    expect(statusAfterApproval('SO', 1)).toBe('L1_APPROVED');
    expect(statusAfterApproval('SO', 2)).toBe('APPROVED');
    /* A Purchase Order takes one signature: the first is the last. */
    expect(statusAfterApproval('PO', 1)).toBe('APPROVED');
    expect(levelsFor('SO')).toBe(2);
  });
  it('the Purchase Order signs nothing: it is reason-only', () => {
    expect(levelsFor('PO')).toBe(0);
    expect(isReasonOnly('PO')).toBe(true);
    expect(isReasonOnly('SO')).toBe(false);
    expect(CANCEL_APPROVE_KEY.PO[1]).toBeUndefined();
    expect(CANCEL_APPROVE_KEY.PO[2]).toBeUndefined();
    /* No key signs it, so no wildcard does either. */
    expect(approvalRefusal(req({ doc_type: 'PO' }), signer(2, ['*']))).toMatchObject({ refusal: { error: 'not_pending', httpStatus: 409 } });
    expect(holdsAnyApproveKey('PO', signer(1, ['*']))).toBe(false);
  });
  it('counts signatures for the "1 of 2" wording, per document', () => {
    expect(signaturesGiven('SO', 'REQUESTED')).toBe(0);
    expect(signaturesGiven('SO', 'L1_APPROVED')).toBe(1);
    expect(signaturesGiven('SO', 'APPROVED')).toBe(2);
    expect(signaturesGiven('SO', 'EXECUTED')).toBe(2);
    expect(signaturesGiven('SO', 'WITHDRAWN')).toBe(0);
    expect(signaturesGiven('PO', 'APPROVED')).toBe(0);
  });
  it('knows which requests are still open', () => {
    expect(isOpenCancelStatus('REQUESTED')).toBe(true);
    expect(isOpenCancelStatus('L1_APPROVED')).toBe(true);
    expect(isOpenCancelStatus('APPROVED')).toBe(true);
    expect(isOpenCancelStatus('EXECUTED')).toBe(false);
    expect(isOpenCancelStatus('REJECTED')).toBe(false);
    expect(isOpenCancelStatus(null)).toBe(false);
  });
});

describe('approving', () => {
  it('level 1 needs the level-1 key for that document', () => {
    expect(approvalRefusal(req(), signer(2, ['scm.so_cancel.approve_l1']))).toEqual({ level: 1 });
    expect(approvalRefusal(req(), signer(2, ['scm.so_cancel.approve_l2']))).toMatchObject({ refusal: { error: 'approve_forbidden', httpStatus: 403 } });
    /* The Purchase Order has no level at all: an old row still saying
       REQUESTED or L1_APPROVED is not signable by anyone. */
    expect(approvalRefusal(req({ doc_type: 'PO' }), signer(2, ['scm.so_cancel.approve_l1']))).toMatchObject({ refusal: { error: 'not_pending' } });
    expect(approvalRefusal(req({ doc_type: 'PO', status: 'L1_APPROVED', l1_by: 2 }), signer(3, ['*']))).toMatchObject({ refusal: { error: 'not_pending', httpStatus: 409 } });
  });
  it('level 2 needs the level-2 key and a DIFFERENT person from level 1', () => {
    const l1Done = req({ status: 'L1_APPROVED', l1_by: 2 });
    expect(approvalRefusal(l1Done, signer(3, ['scm.so_cancel.approve_l2']))).toEqual({ level: 2 });
    expect(approvalRefusal(l1Done, signer(2, ['*']))).toMatchObject({ refusal: { error: 'same_signer', httpStatus: 403 } });
    expect(approvalRefusal(l1Done, signer(3, ['scm.so_cancel.approve_l1']))).toMatchObject({ refusal: { error: 'approve_forbidden' } });
  });
  it('never lets the requester sign their own request, wildcard or not', () => {
    expect(approvalRefusal(req({ requested_by: 9 }), signer(9, ['*']))).toMatchObject({ refusal: { error: 'self_approval', httpStatus: 403 } });
    expect(approvalRefusal(req({ status: 'L1_APPROVED', requested_by: 9, l1_by: 2 }), signer(9, ['*']))).toMatchObject({ refusal: { error: 'self_approval' } });
  });
  it('the wildcard signs either level, still one level per person', () => {
    expect(approvalRefusal(req(), signer(5, ['*']))).toEqual({ level: 1 });
    expect(approvalRefusal(req({ status: 'L1_APPROVED', l1_by: 5 }), signer(6, ['*']))).toEqual({ level: 2 });
  });
  it('refuses when nothing is pending', () => {
    expect(approvalRefusal(req({ status: 'APPROVED' }), signer(2, ['*']))).toMatchObject({ refusal: { error: 'not_pending', httpStatus: 409 } });
    expect(approvalRefusal(req({ status: 'REJECTED' }), signer(2, ['*']))).toMatchObject({ refusal: { error: 'not_pending' } });
  });
});

describe('rejecting and withdrawing', () => {
  it('either approver desk may reject while a signature is pending', () => {
    expect(rejectRefusal(req(), signer(2, ['scm.so_cancel.approve_l2']))).toBeNull();
    expect(rejectRefusal(req({ status: 'L1_APPROVED', l1_by: 2 }), signer(2, ['scm.so_cancel.approve_l1']))).toBeNull();
    /* Nobody may refuse a PO request, because nobody may sign one. */
    expect(rejectRefusal(req({ doc_type: 'PO' }), signer(2, ['*']))).toMatchObject({ error: 'reject_forbidden', httpStatus: 403 });
    expect(rejectRefusal(req({ status: 'APPROVED' }), signer(2, ['*']))).toMatchObject({ error: 'not_pending', httpStatus: 409 });
  });
  it('the requester may withdraw at any open point; an approver may too; nobody else', () => {
    expect(withdrawRefusal(req({ requested_by: 1 }), signer(1, []))).toBeNull();
    expect(withdrawRefusal(req({ status: 'APPROVED', requested_by: 1 }), signer(1, []))).toBeNull();
    expect(withdrawRefusal(req(), signer(7, ['scm.so_cancel.approve_l1']))).toBeNull();
    expect(withdrawRefusal(req(), signer(7, []))).toMatchObject({ error: 'withdraw_forbidden', httpStatus: 403 });
    expect(withdrawRefusal(req({ status: 'EXECUTED', requested_by: 1 }), signer(1, []))).toMatchObject({ error: 'not_open', httpStatus: 409 });
  });
  it('holdsAnyApproveKey knows the document', () => {
    expect(holdsAnyApproveKey('SO', signer(1, ['scm.so_cancel.approve_l2']))).toBe(true);
    expect(holdsAnyApproveKey('PO', signer(1, ['scm.so_cancel.approve_l2']))).toBe(false);
    expect(holdsAnyApproveKey('XX', signer(1, ['*']))).toBe(false);
  });
});

describe('what may be asked about, and what may run', () => {
  it('a draft needs no approval, and a purchase order never does', () => {
    expect(cancelNeedsApproval('SO', 'DRAFT')).toBe(false);
    expect(cancelNeedsApproval('SO', 'CONFIRMED')).toBe(true);
    expect(cancelNeedsApproval('PO', 'draft')).toBe(false);
    expect(cancelNeedsApproval('PO', 'SUBMITTED')).toBe(false);
    expect(cancelNeedsApproval('PO', null)).toBe(false);
  });
  it('refuses a request on a document that cannot be cancelled anyway', () => {
    expect(cancelRequestRefusal('SO', 'CONFIRMED')).toBeNull();
    expect(cancelRequestRefusal('SO', 'CANCELLED')).toMatchObject({ error: 'already_cancelled' });
    expect(cancelRequestRefusal('SO', 'CLOSED')).toMatchObject({ error: 'closed' });
    expect(cancelRequestRefusal('SO', 'DRAFT')).toMatchObject({ error: 'draft_is_discarded' });
  });
  it('refuses a request on a purchase order at every status — there is none to raise', () => {
    for (const st of ['SUBMITTED', 'PARTIALLY_RECEIVED', 'DRAFT', 'RECEIVED', 'CANCELLED', null]) {
      expect(cancelRequestRefusal('PO', st)).toMatchObject({ error: 'no_approval_needed' });
    }
  });
  it('the cancel may run only on an APPROVED request', () => {
    expect(executionRefusal('SO', null)).toMatchObject({ error: 'cancel_approval_required' });
    expect(executionRefusal('SO', { status: 'REQUESTED' })?.message).toContain('0 of 2');
    expect(executionRefusal('SO', { status: 'L1_APPROVED' })?.message).toContain('1 of 2');
    expect(executionRefusal('SO', { status: 'APPROVED' })).toBeNull();
    /* A purchase order waits for nobody: the guard gates it on the reason
       instead, and this rule must never hold it up. */
    expect(executionRefusal('PO', null)).toBeNull();
    expect(executionRefusal('PO', { status: 'REQUESTED' })).toBeNull();
  });
});
