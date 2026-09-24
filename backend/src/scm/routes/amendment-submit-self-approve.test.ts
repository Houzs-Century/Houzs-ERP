/* Owner 2026-09-24: 「for SO amendment - 如果是 Logistic admin 修改客户信息,
 * Delivery Date - 无需 approver」.
 *
 * The submit route may now tell the caller that a half needs no second
 * signature. What must stay true, and is pinned here, is that it only TELLS:
 * the amendment row is still written REQUESTED and the apply still goes through
 * the ordinary approve route, which re-checks the key and carries the date-pair
 * re-check, the deposit gate, the revision bump and the audit. A create route
 * that applied the change itself would be a second approval path — the class of
 * bug this file exists to refuse.
 *
 * Same shape as amendment-submit-lane.test.ts: the handler lives in a
 * 12,000-line router that cannot be driven end to end here, so this pins the
 * WIRING and shared/amendment-self-approve.test.ts pins the rule. */
import { describe, expect, it } from 'vitest';
/* `?raw`, not node:fs — backend/tsconfig.json types Workers only. */
import { soRouterSource } from '../../../tests/lib/so-router-source';
const rawRoute = soRouterSource();

const start = rawRoute.indexOf("mfgSalesOrders.post('/:docNo/amendments'");
const handler = start < 0 ? '' : rawRoute.slice(start, rawRoute.indexOf('\nmfgSalesOrders.', start + 10));

describe('the submit route offers the delivery desk its own change', () => {
  it('finds the handler (a pin over nothing must not pass)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain("from('so_amendments').insert(");
  });

  it('asks the SHARED rule, with the lane and whether that half touches a line', () => {
    expect(handler).toMatch(
      /laneSelfApproves\(laneKey, \{ holdsLaneKey: holdsDeliveryKey, hasLineChanges: half\.lines\.length > 0 \}\)/,
    );
    /* The key comes from the shared table, not a fourth spelling of it. The pin
       is on the CALL, not on the absence of the literal: the literal appears
       once more in this handler, in the pre-existing isLaneApprover gate that
       lets an approver RAISE a request. */
    expect(handler).toMatch(/hasHouzsPerm\(c, SELF_APPROVE_KEY\)/);
  });

  it('keeps no private copy of the rule', () => {
    expect(handler).not.toMatch(/lane === 'DELIVERY' &&/);
  });

  it('APPLIES NOTHING — the row is still written REQUESTED and no apply runs here', () => {
    const insert = handler.slice(handler.indexOf("from('so_amendments').insert("));
    expect(insert).toMatch(/status:\s+'REQUESTED',/);
    expect(insert).not.toContain("'SO_APPROVED'");
    /* Not a call to the apply engine anywhere: the three mentions of it in this
       handler are comments about what the APPROVE step re-checks. */
    expect(handler).not.toMatch(/applySoAmendment\(/);
    expect(handler).not.toContain('approveSoCommandHandler');
  });

  it('does not ask a desk to sign what it raised itself', () => {
    expect(handler).toMatch(/created: createdAmendments\.filter\(\(a\) => !selfApprovable\.includes\(a\.id\)\)/);
  });

  it('answers the ids, so the caller can run the ordinary approve route', () => {
    const response = handler.slice(handler.lastIndexOf('return c.json({'));
    expect(response).toMatch(/selfApprovable,/);
  });
});
