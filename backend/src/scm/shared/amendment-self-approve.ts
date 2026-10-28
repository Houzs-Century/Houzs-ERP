// amendment-self-approve — may a freshly raised amendment apply WITHOUT waiting
// for a second pair of eyes?
//
// THE OWNER, 2026-09-24: 「for SO amendment - 如果是 Logistic admin 修改客户信息,
// Delivery Date - 无需 approver」. The Logistic desk changing a delivery date or a
// customer's address on a processing-locked order was raising a request and then
// signing it themselves — two steps and a queue row for a decision that was only
// ever theirs. The amendment is still WRITTEN (the revision snapshot, the audit
// row, the AutoCount write-back all hang off it); what is skipped is the WAIT.
//
// THE RULE IS NARROW ON PURPOSE, and the two limits are the owner's:
//
//   · DELIVERY lane only. A product-line change still signs with the Purchaser
//     (approving one auto-raises a PO amendment the supplier must follow) and a
//     2990 price change still signs with Finance. Neither desk self-applies.
//   · HEADER fields only. The DELIVERY lane also carries SERVICE lines — the
//     delivery fee, disposal, lifting (`SVC-*`, amendment-lane.ts) — and those
//     are MONEY. A lane half that touches a line keeps its signature even when
//     the Logistic desk raised it.
//
// WHO. Whoever could sign that lane anyway (`scm.amendment.approve_delivery`,
// wildcard included). This grants nobody a new power: it removes a step from a
// person who already held both ends of it. A salesperson, or a Purchaser holding
// only `approve_lines`, raises a request exactly as before.
//
// NOT A NEW WRITE PATH. The amendment is applied by the SAME approve route the
// approver's own click runs, with every guard it carries (the date-pair
// re-check, the deposit / completeness gate, the revision bump, the audit, the
// notices). This module only answers WHETHER that step may be taken without a
// second person — it never applies anything.

import type { AmendmentLane } from './amendment-lane';
import { LANE_APPROVE_KEY } from './amendment-lane';

/** The one lane a desk may apply on its own. Not a list: the other two lanes
 *  each have a reason not to be here (a PO follows LINES; PRICE is money). */
export const SELF_APPROVE_LANE: AmendmentLane = 'DELIVERY';

/** The permission that both signs that lane and unlocks the shortcut. */
export const SELF_APPROVE_KEY = LANE_APPROVE_KEY[SELF_APPROVE_LANE];

export type SelfApproveInput = {
  /** Does the caller hold the lane's approve key (a `*` wildcard counts)? */
  holdsLaneKey: boolean;
  /** Does THIS lane half change any line — i.e. a service line? */
  hasLineChanges: boolean;
};

/**
 * May this lane half of a submission apply the moment it is raised?
 *
 * Every argument is about the SUBMISSION, never about the person's intent: the
 * caller cannot ask for this and there is no flag in the request body. A change
 * that qualifies takes the shortcut; one that does not goes to the queue, and
 * the requester is told which happened.
 */
export function laneSelfApproves(lane: AmendmentLane | null | undefined, input: SelfApproveInput): boolean {
  if (lane !== SELF_APPROVE_LANE) return false;
  if (!input.holdsLaneKey) return false;
  if (input.hasLineChanges) return false;
  return true;
}

/** Why a half did NOT take the shortcut — for the audit note and the tests, so
 *  "it still asked for approval" always has a stated reason. */
export function selfApproveRefusal(lane: AmendmentLane | null | undefined, input: SelfApproveInput): string | null {
  if (lane !== SELF_APPROVE_LANE) return `lane ${lane ?? 'legacy'} always needs its approver`;
  if (!input.holdsLaneKey) return 'requester does not hold the delivery approve key';
  if (input.hasLineChanges) return 'the request changes a service line, which is money';
  return null;
}
