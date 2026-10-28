// Posting a GRN (stock IN) needs the Post GRN position capability, separately
// from Goods Receipt edit. Owner 2026-10-01: the storekeeper receives — drafts
// the GRN and scans each line's rack — and the purchaser confirms. So a caller
// with GRN edit but without this capability may save drafts only.
//
// Checked on every path that posts: create-as-posted (POST /), the two from-PO
// converts that post at once, and the DRAFT -> POSTED confirm. `*` (Super
// Admin / Owner / Managing Director) passes inside hasPositionCapability.
import {
  hasPositionCapability,
  type PositionCapabilityCaller,
} from '../../services/positionCapabilities';

export const GRN_POST_CAPABILITY = 'scm.grn.post';

export const GRN_POST_REFUSAL = {
  error: 'capability_required',
  reason: 'Posting a goods receipt needs the Post GRN permission. Save it as a draft for your purchaser to post.',
} as const;

export function grnPostRefusal(caller: PositionCapabilityCaller | null | undefined): typeof GRN_POST_REFUSAL | null {
  return hasPositionCapability(caller, GRN_POST_CAPABILITY) ? null : GRN_POST_REFUSAL;
}
