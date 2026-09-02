// The owner's four layers (2026-09-02), question by question. Every cell of
// the state machine in pv-approval.ts is asserted here so a route can never
// quietly disagree with the screen about what a voucher in the cycle may do.
//
//   Draft -> Prepared (still editable) -> Checked (locked) -> Approved (=GL)
//   any reject -> Draft. Bank truth stays with reconciliation.

import { describe, expect, test } from 'vitest';
import { pvCanEdit, pvCanPrepare, pvCanCheck, pvCanApprove, pvCanReject, pvCanWithdraw, pvCanPost } from './pv-approval';

const draft = { status: 'DRAFT', submitted_at: null, checked_at: null, approved_at: null };
const prepared = { status: 'DRAFT', submitted_at: '2026-09-02T01:00:00Z', checked_at: null, approved_at: null };
const checked = { status: 'DRAFT', submitted_at: '2026-09-02T01:00:00Z', checked_at: '2026-09-02T02:00:00Z', approved_at: null };
const approved = { status: 'DRAFT', submitted_at: '2026-09-02T01:00:00Z', checked_at: '2026-09-02T02:00:00Z', approved_at: '2026-09-02T03:00:00Z' };
const posted = { status: 'POSTED', submitted_at: '2026-09-02T01:00:00Z', checked_at: '2026-09-02T02:00:00Z', approved_at: '2026-09-02T03:00:00Z' };
const cancelled = { status: 'CANCELLED', submitted_at: null, checked_at: null, approved_at: null };

describe('editing', () => {
  test('a raw draft is editable', () => {
    expect(pvCanEdit(draft).ok).toBe(true);
  });
  test('a PREPARED voucher is STILL editable — the owner kept it so (prepare 还可以改)', () => {
    expect(pvCanEdit(prepared).ok).toBe(true);
  });
  test('the first yes locks it — checked is frozen, and the refusal says reject-back', () => {
    const v = pvCanEdit(checked);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/Reject it back to draft/);
  });
  test('approved is frozen harder — what was approved is what gets paid', () => {
    const v = pvCanEdit(approved);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/what was approved is what gets paid/);
  });
});

describe('preparing', () => {
  test('a raw draft may be prepared', () => {
    expect(pvCanPrepare(draft).ok).toBe(true);
  });
  test('twice is refused', () => {
    const v = pvCanPrepare(prepared);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('already_prepared');
  });
  test('posted and cancelled vouchers are history', () => {
    expect(pvCanPrepare(posted).ok).toBe(false);
    expect(pvCanPrepare(cancelled).ok).toBe(false);
  });
});

describe('checking (the first yes)', () => {
  test('only a prepared voucher can be checked', () => {
    expect(pvCanCheck(prepared).ok).toBe(true);
    const v = pvCanCheck(draft);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('not_prepared');
  });
  test('checking twice is refused', () => {
    const v = pvCanCheck(checked);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('already_checked');
  });
});

describe('approving (the second yes IS the posting)', () => {
  test('only a checked voucher can be approved — the first yes comes first', () => {
    expect(pvCanApprove(checked).ok).toBe(true);
    const early = pvCanApprove(prepared);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.message).toMatch(/first yes comes before yours/);
    const never = pvCanApprove(draft);
    expect(never.ok).toBe(false);
    if (!never.ok) expect(never.error).toBe('not_checked');
  });
  test('approving twice is refused by the table (the route resumes a died post itself)', () => {
    const v = pvCanApprove(approved);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('already_approved');
  });
});

describe('rejecting — 一律退回 Draft', () => {
  test('either layer may reject: prepared, checked, even approved-but-unposted', () => {
    expect(pvCanReject(prepared).ok).toBe(true);
    expect(pvCanReject(checked).ok).toBe(true);
    expect(pvCanReject(approved).ok).toBe(true);
  });
  test('a raw draft has nothing to reject; history is history', () => {
    expect(pvCanReject(draft).ok).toBe(false);
    expect(pvCanReject(posted).ok).toBe(false);
  });
});

describe('withdrawing', () => {
  test('the preparer may pull back only BEFORE the first yes', () => {
    expect(pvCanWithdraw(prepared).ok).toBe(true);
    const late = pvCanWithdraw(checked);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.message).toMatch(/only be rejected back/);
  });
  test('a voucher never in the cycle has nothing to withdraw', () => {
    expect(pvCanWithdraw(draft).ok).toBe(false);
  });
});

describe('the gate money leaves through', () => {
  test('unapproved never posts, and the sentence names the path', () => {
    const fresh = pvCanPost(draft);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.message).toMatch(/Prepare it, have it checked/);
    const waiting = pvCanPost(checked);
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) expect(waiting.message).toMatch(/awaiting approval/);
  });
  test('approved posts', () => {
    expect(pvCanPost(approved).ok).toBe(true);
  });
});
