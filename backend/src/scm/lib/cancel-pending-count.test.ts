/* The "Sales Order Amendment" sidebar badge counts cancellation requests too
   since owner 2026-09-24, because the queue under it lists them. The badge and
   the approve button must never disagree about whose signature a row waits for
   — so the count runs the approve gate's OWN rule (approvalRefusal), and this
   file pins the four ways a row can be waiting for SOMEONE ELSE. */

import { describe, expect, it } from 'vitest';
import { countCancelRequestsAwaitingSigner } from './cancel-pending-count';
import type { CancelRequestLike } from '../shared/document-cancel';

const L1 = 'scm.so_cancel.approve_l1';
const L2 = 'scm.so_cancel.approve_l2';

const row = (over: Partial<CancelRequestLike> = {}): CancelRequestLike => ({
  doc_type: 'SO',
  status: 'REQUESTED',
  requested_by: 99,
  l1_by: null,
  ...over,
});

const signer = (userId: number, ...keys: string[]) => ({
  userId,
  holds: (k: string) => keys.includes(k),
});

describe('countCancelRequestsAwaitingSigner', () => {
  it('counts a request waiting for the level this signer holds', () => {
    expect(countCancelRequestsAwaitingSigner([row()], signer(1, L1))).toBe(1);
    expect(countCancelRequestsAwaitingSigner([row({ status: 'L1_APPROVED', l1_by: 5 })], signer(1, L2))).toBe(1);
  });

  it('does not count the OTHER level', () => {
    expect(countCancelRequestsAwaitingSigner([row()], signer(1, L2))).toBe(0);
    expect(countCancelRequestsAwaitingSigner([row({ status: 'L1_APPROVED', l1_by: 5 })], signer(1, L1))).toBe(0);
  });

  it('never counts a request the signer raised themselves', () => {
    expect(countCancelRequestsAwaitingSigner([row({ requested_by: 1 })], signer(1, L1))).toBe(0);
  });

  it('never counts a level 2 the signer already signed at level 1', () => {
    expect(countCancelRequestsAwaitingSigner([row({ status: 'L1_APPROVED', l1_by: 1 })], signer(1, L1, L2))).toBe(0);
  });

  it('counts nothing that is no longer waiting for a signature', () => {
    const closed = ['APPROVED', 'EXECUTED', 'REJECTED', 'WITHDRAWN'].map((status) => row({ status }));
    expect(countCancelRequestsAwaitingSigner(closed, signer(1, L1, L2))).toBe(0);
  });

  it('counts nothing on a document type that signs nothing', () => {
    expect(countCancelRequestsAwaitingSigner([row({ doc_type: 'PO' }), row({ doc_type: 'DO' })], signer(1, L1, L2))).toBe(0);
  });

  it('counts each waiting row once', () => {
    const rows = [row(), row({ requested_by: 98 }), row({ status: 'L1_APPROVED', l1_by: 5 })];
    expect(countCancelRequestsAwaitingSigner(rows, signer(1, L1))).toBe(2);
  });
});
