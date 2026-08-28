// The phase-3 rule table, question by question. Every cell of the state
// machine in pv-approval.ts is asserted here so a route can never quietly
// disagree with the screen about what a voucher in the queue may do.

import { describe, expect, test } from 'vitest';
import { pvCanEdit, pvCanSubmit, pvCanDecide, pvCanWithdraw, pvCanPost } from './pv-approval';

const draft = { status: 'DRAFT', submitted_at: null, approved_at: null };
const submitted = { status: 'DRAFT', submitted_at: '2026-08-28T01:00:00Z', approved_at: null };
const approved = { status: 'DRAFT', submitted_at: '2026-08-28T01:00:00Z', approved_at: '2026-08-28T02:00:00Z' };
const posted = { status: 'POSTED', submitted_at: '2026-08-28T01:00:00Z', approved_at: '2026-08-28T02:00:00Z' };
const cancelled = { status: 'CANCELLED', submitted_at: null, approved_at: null };

describe('editing', () => {
  test('a fresh draft is editable', () => {
    expect(pvCanEdit(draft).ok).toBe(true);
  });
  test('a submitted voucher is frozen, and the refusal says withdraw', () => {
    const v = pvCanEdit(submitted);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/Withdraw it to edit/);
  });
  test('an approved voucher is frozen harder — what was approved is what gets paid', () => {
    const v = pvCanEdit(approved);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/what was approved is what gets paid/);
  });
});

describe('submitting', () => {
  test('a fresh draft may enter the queue', () => {
    expect(pvCanSubmit(draft).ok).toBe(true);
  });
  test('twice is refused', () => {
    const v = pvCanSubmit(submitted);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('already_submitted');
  });
  test('posted and cancelled vouchers are history', () => {
    expect(pvCanSubmit(posted).ok).toBe(false);
    expect(pvCanSubmit(cancelled).ok).toBe(false);
  });
});

describe('deciding (approve / reject)', () => {
  test('only a submitted voucher can be decided', () => {
    expect(pvCanDecide(submitted).ok).toBe(true);
    const v = pvCanDecide(draft);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('not_submitted');
  });
  test('deciding twice is refused', () => {
    const v = pvCanDecide(approved);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toBe('already_approved');
  });
});

describe('withdrawing', () => {
  test('submitted and approved vouchers can both come back', () => {
    expect(pvCanWithdraw(submitted).ok).toBe(true);
    expect(pvCanWithdraw(approved).ok).toBe(true);
  });
  test('a voucher never in the queue has nothing to withdraw', () => {
    expect(pvCanWithdraw(draft).ok).toBe(false);
  });
});

describe('the gate money leaves through', () => {
  test('unapproved never posts, and the sentence names the path', () => {
    const fresh = pvCanPost(draft);
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) expect(fresh.message).toMatch(/Submit it, get it approved/);
    const waiting = pvCanPost(submitted);
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) expect(waiting.message).toMatch(/awaiting approval/);
  });
  test('approved posts', () => {
    expect(pvCanPost(approved).ok).toBe(true);
  });
});
