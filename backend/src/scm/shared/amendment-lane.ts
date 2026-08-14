// amendment-lane — PURE classification of an SO amendment's changes into the
// TWO APPROVAL LANES of the owner's 2026-07-27 rework:
//
//   LINES    — product-line changes (SKU/spec, colour/fabric, qty, sell price,
//              add/remove a product line). Approved by Purchasing
//              (scm.amendment.approve_lines); applying may spawn a follow-up
//              PO Amendment for the purchaser to confirm.
//   DELIVERY — delivery/customer-side changes (schedule dates, State/Postcode/
//              City — and, later phases, address lines / disposal / transport
//              charges). Approved by Logistics
//              (scm.amendment.approve_delivery); applying never touches a PO.
//
// A submission that mixes both classes is SPLIT at create time into two
// amendment documents, one per lane, each with its own approver and lifecycle
// (the lanes never wait for each other). This module is the single source of
// truth for "which lane does this change belong to" — the create route, the
// gates and the frontend all key off the SAME table, so a field can never be
// purchasing's to approve on one screen and logistics' on another.
//
// LANE OF A HEADER FIELD — keyed by the amendment payloadKey (so-field-policy
// CONTROLLED rows). The schedule dates SPLIT by owner ruling (2026-07-27
// follow-up): Processing Date signs with PURCHASING (it re-times the
// supplier), Delivery Date with LOGISTICS. The pair guard ("set together,
// proc ≤ delivery") validates the COMBINED submission before the split; a
// both-dates reschedule then becomes two one-signature documents.
//
// LANE OF A LINE CHANGE — by the line's ITEM CODE: a SERVICE line (the SVC-
// family — delivery fees, disposal, lifting) is transport/execution charges
// wearing a line's clothes, so it routes to DELIVERY (the owner's category 2
// names "disposal add on" and "transportation charges" explicitly); every real
// product line routes to LINES. Service lines are never PO'd to a furniture
// supplier, so this split also keeps the PO follow-up purely product-side.

import { isServiceSkuCode } from './service-sku';

export type AmendmentLane = 'LINES' | 'DELIVERY';

/** Flat permission key that approves a given lane (services/permissions.ts). */
export const LANE_APPROVE_KEY: Record<AmendmentLane, string> = {
  LINES: 'scm.amendment.approve_lines',
  DELIVERY: 'scm.amendment.approve_delivery',
};

/** Human label used in audit rows + API refusal messages. */
export const LANE_LABEL: Record<AmendmentLane, string> = {
  LINES: 'product lines',
  DELIVERY: 'delivery / customer info',
};

/* Header payloadKey → lane. Every CONTROLLED key in so-field-policy MUST have a
   row here — classifyHeaderKey throws on an unknown key rather than guessing a
   lane, and the create route validates keys against soAmendableHeaderFields()
   BEFORE classifying, so a throw here means the two tables drifted. */
const HEADER_KEY_LANE: Record<string, AmendmentLane> = {
  /* Owner 2026-07-27 (follow-up ruling): the Processing Date is PURCHASING's —
     it re-times the supplier's production, so it signs on the LINES lane. The
     Delivery Date stays with Logistics. A submission that moves BOTH dates
     therefore splits into two documents, one per signer; the pair validation
     (set together, proc ≤ delivery) runs at SUBMIT on the combined values, and
     the lanes apply independently after that. */
  processingDate:       'LINES',
  customerDeliveryDate: 'DELIVERY',
  customerState:        'DELIVERY',
  postcode:             'DELIVERY',
  city:                 'DELIVERY',
  // Phase 2 (owner 2026-07-27): the delivery-address block + disposal note —
  // category-2 fields by the owner's own list, all Logistics-approved.
  address1:             'DELIVERY',
  address2:             'DELIVERY',
  address3:             'DELIVERY',
  address4:             'DELIVERY',
  shipToAddress:        'DELIVERY',
  billToAddress:        'DELIVERY',
  installToAddress:     'DELIVERY',
  replacementDisposal:  'DELIVERY',
};

export function classifyHeaderKey(payloadKey: string): AmendmentLane {
  const lane = HEADER_KEY_LANE[payloadKey];
  if (!lane) {
    throw new Error(`amendment-lane: header key "${payloadKey}" has no lane — add it to HEADER_KEY_LANE.`);
  }
  return lane;
}

/** Lane of one line change, by the item code that identifies what the line IS.
 *  For an ADD the code is the requested new_item_code; for SPEC/QTY/REMOVE the
 *  caller passes the EXISTING SO line's item_code (resolved server-side — never
 *  trusted from the client). A missing/unknown code defaults to LINES: a
 *  product change mis-routed to purchasing is reviewable noise, a product
 *  change mis-routed AWAY from purchasing is an unreviewed spec change. */
export function classifyLineItemCode(itemCode: string | null | undefined): AmendmentLane {
  return isServiceSkuCode(itemCode ?? null) ? 'DELIVERY' : 'LINES';
}

export type LaneSplitLine<L> = { line: L; lane: AmendmentLane };

export type LaneSplit<L> = {
  /** Lanes actually present, in stable order (LINES first). */
  lanes: AmendmentLane[];
  perLane: Record<AmendmentLane, {
    headerChanges: Record<string, string | null>;
    headerKeys: string[];
    lines: L[];
  }>;
};

/**
 * Split one validated submission into its lane halves. `lineItemCode` resolves
 * the item code a line change targets (ADD → newItemCode, others → the SO
 * line's current code, looked up by the caller).
 */
export function splitAmendmentByLane<L>(
  headerChanges: Record<string, string | null>,
  lines: L[],
  lineItemCode: (line: L) => string | null | undefined,
): LaneSplit<L> {
  const mk = () => ({ headerChanges: {} as Record<string, string | null>, headerKeys: [] as string[], lines: [] as L[] });
  const perLane: LaneSplit<L>['perLane'] = { LINES: mk(), DELIVERY: mk() };

  for (const [k, v] of Object.entries(headerChanges)) {
    const lane = classifyHeaderKey(k);
    perLane[lane].headerChanges[k] = v;
    perLane[lane].headerKeys.push(k);
  }
  for (const line of lines) {
    perLane[classifyLineItemCode(lineItemCode(line))].lines.push(line);
  }

  const lanes = (['LINES', 'DELIVERY'] as AmendmentLane[]).filter(
    (l) => perLane[l].headerKeys.length > 0 || perLane[l].lines.length > 0,
  );
  return { lanes, perLane };
}

/* ── Lane state machine ──────────────────────────────────────────────────────
   A lane amendment lives entirely inside the EXISTING status enum so no enum
   migration / historical remap is needed:

     REQUESTED ──approve-so──▶ SO_APPROVED   (terminal: applied)
         │
         ├─────reject────────▶ REJECTED      (terminal: refused, reason required)
         └─────withdraw──────▶ REJECTED      (terminal: resolution WITHDRAWN)

   SUPPLIER_PENDING / PO_APPROVED / SENT are LEGACY-ONLY states — a lane row can
   never enter them (there is no supplier-confirm gate and the PO leg lives in
   the PO Amendments module). Legacy rows (lane IS NULL) keep the original FLOW
   in so-amendment.ts untouched. */
export type LaneAction = 'approve-so' | 'reject' | 'withdraw';

export function canLaneTransition(status: string, action: LaneAction | string): boolean {
  if (status !== 'REQUESTED') return false;
  return action === 'approve-so' || action === 'reject' || action === 'withdraw';
}

/** Terminal status a lane action lands on (mirror of actionTargetStatus). */
export function laneActionTarget(action: LaneAction): 'SO_APPROVED' | 'REJECTED' {
  return action === 'approve-so' ? 'SO_APPROVED' : 'REJECTED';
}

/** True when a lane row's status means "still awaiting its approver". */
export const laneIsOpen = (status: string): boolean => status === 'REQUESTED';
