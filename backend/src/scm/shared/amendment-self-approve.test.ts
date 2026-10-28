/* Owner 2026-09-24: 「如果是 Logistic admin 修改客户信息, Delivery Date - 无需
   approver」. The shortcut is narrow, and each limit here is the owner's or a
   consequence of one — a test per limit, because the cost of the rule being one
   notch wider is a change applied to a live order with nobody's signature. */

import { describe, expect, it } from 'vitest';
import { laneSelfApproves, selfApproveRefusal, SELF_APPROVE_KEY, SELF_APPROVE_LANE } from './amendment-self-approve';

const logistic = { holdsLaneKey: true, hasLineChanges: false };

describe('laneSelfApproves', () => {
  it('lets the delivery desk apply its own header-only change', () => {
    expect(laneSelfApproves('DELIVERY', logistic)).toBe(true);
    expect(selfApproveRefusal('DELIVERY', logistic)).toBeNull();
  });

  it('never shortcuts the other lanes, whatever the caller holds', () => {
    expect(laneSelfApproves('LINES', logistic)).toBe(false);
    expect(laneSelfApproves('PRICE', logistic)).toBe(false);
    // A legacy (lane NULL) row keeps the old two-gate chain.
    expect(laneSelfApproves(null, logistic)).toBe(false);
    expect(selfApproveRefusal('LINES', logistic)).toMatch(/always needs its approver/);
  });

  it('never shortcuts for someone who could not sign it anyway', () => {
    expect(laneSelfApproves('DELIVERY', { ...logistic, holdsLaneKey: false })).toBe(false);
    expect(selfApproveRefusal('DELIVERY', { ...logistic, holdsLaneKey: false }))
      .toMatch(/does not hold the delivery approve key/);
  });

  it('never shortcuts a half that touches a service line — that is money', () => {
    expect(laneSelfApproves('DELIVERY', { ...logistic, hasLineChanges: true })).toBe(false);
    expect(selfApproveRefusal('DELIVERY', { ...logistic, hasLineChanges: true }))
      .toMatch(/service line, which is money/);
  });

  it('is keyed on the lane that signs it, not a second copy of the key', () => {
    expect(SELF_APPROVE_LANE).toBe('DELIVERY');
    expect(SELF_APPROVE_KEY).toBe('scm.amendment.approve_delivery');
  });
});
