// amendment-lane — PURE classification of an SO amendment's changes into its
// APPROVAL LANES (the owner's 2026-07-27 rework, plus the 2026-09-21 PRICE lane):
//
//   LINES    — product-line changes (SKU/spec, colour/fabric, qty, add/remove a
//              product line — and sell price EXCEPT the price-lane carve-out
//              below). Approved by Purchasing (scm.amendment.approve_lines);
//              applying may spawn a follow-up PO Amendment for the purchaser.
//   DELIVERY — delivery/customer-side changes (schedule dates, State/Postcode/
//              City — and, later phases, address lines / disposal / transport
//              charges). Approved by Logistics
//              (scm.amendment.approve_delivery); applying never touches a PO.
//   PRICE    — a PRICE-ONLY product-line change (only unit price and/or discount
//              moved; SKU/colour/qty/remark unchanged). Owner 2026-09-21 (2990)
//              and 2026-09-25 (HOUZS): the sell price is the Sales Director's,
//              not the Purchaser's — it changes what the CUSTOMER pays and
//              carries nothing for the PO to follow. Approved by
//              scm.amendment.approve_price; applying never touches a PO. See
//              PRICE_LANE_COMPANY_CODES.
//
// A submission that mixes lanes is SPLIT at create time into one amendment
// document per lane, each with its own approver and lifecycle
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
// LANE OF A LINE CHANGE — by WHETHER THE LINE IS A SERVICE LINE: a service line
// (delivery fees, disposal, lifting, storage, transport) is transport/execution
// charges wearing a line's clothes, so it routes to DELIVERY (the owner's
// category 2 names "disposal add on" and "transportation charges" explicitly);
// every real product line routes to LINES. Service lines are never PO'd to a
// furniture supplier, so this split also keeps the PO follow-up purely
// product-side.
//
// Service-ness is the FULL isServiceLine signal (item_group / category / SVC-
// code), NOT the SVC- prefix alone: the go-live / AutoCount lines carry BARE
// codes (DISPOSE, STORAGE, TRANSPORTATION CHARGES) with item_group='service' and
// no SVC- prefix, and a prefix-only test mis-routed all of them to LINES — a
// Logistics charge landed in Purchasing's queue and (once approved) spawned an
// empty PO follow-up (owner 2026-09-11, docs/bugs). The caller resolves the SO
// line's item_group server-side and passes it alongside the code.

import { isServiceLine } from './service-sku';

export type AmendmentLane = 'LINES' | 'DELIVERY' | 'PRICE';

/** Companies whose SO amendments carve a price-only line into the PRICE lane.
 *  Keyed on companies.code, never the numeric id — ids drift between prod /
 *  staging / test, the code does not (mig 0216 grants target roles by name for
 *  the same reason). */
export const PRICE_LANE_COMPANY_CODES: ReadonlySet<string> = new Set(['2990', 'HOUZS']);

/** Flat permission key that approves a given lane (services/permissions.ts). */
export const LANE_APPROVE_KEY: Record<AmendmentLane, string> = {
  LINES: 'scm.amendment.approve_lines',
  DELIVERY: 'scm.amendment.approve_delivery',
  PRICE: 'scm.amendment.approve_price',
};

/** Human label used in audit rows + API refusal messages. */
export const LANE_LABEL: Record<AmendmentLane, string> = {
  LINES: 'product lines',
  DELIVERY: 'delivery / customer info',
  PRICE: 'price',
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
  // Customer info (owner 2026-08-21): the contact block joins the CONTROLLED
  // set (so-field-policy) and signs with Logistics — the lane whose label has
  // always read "delivery / customer info". Never touches a PO.
  debtorName:           'DELIVERY',
  phone:                'DELIVERY',
  email:                'DELIVERY',
};

export function classifyHeaderKey(payloadKey: string): AmendmentLane {
  const lane = HEADER_KEY_LANE[payloadKey];
  if (!lane) {
    throw new Error(`amendment-lane: header key "${payloadKey}" has no lane — add it to HEADER_KEY_LANE.`);
  }
  return lane;
}

/** The identity that decides a line's lane. item_group is the authoritative
 *  signal for a service line whose bare code (DISPOSE / STORAGE / TRANSPORTATION
 *  CHARGES) predates the SVC- vocabulary. An ADD has no SO line and so no
 *  item_group: its code and that code's CATALOGUE category are what is known,
 *  and the category is what recognises a bare-code service being added
 *  (HC-SO-012757/A1, owner 2026-09-14). Resolved SERVER-SIDE — never trusted
 *  from the client. */
export type LineLaneIdentity = { itemCode?: string | null; itemGroup?: string | null; category?: string | null };

/** Lane of one line change, by whether it is a SERVICE line — the FULL
 *  isServiceLine signal (item_group / category / SVC- code), NOT the prefix
 *  alone. A missing/unknown identity defaults to LINES: a product change
 *  mis-routed to purchasing is reviewable noise, a product change mis-routed
 *  AWAY from purchasing is an unreviewed spec change. */
export function classifyLine(identity: LineLaneIdentity): AmendmentLane {
  return isServiceLine({
    itemCode: identity.itemCode ?? null,
    itemGroup: identity.itemGroup ?? null,
    category: identity.category ?? null,
  }) ? 'DELIVERY' : 'LINES';
}

/** Code-only convenience, for a caller with no catalogue read. The submit route
 *  does not use it for an ADD: it passes the code's catalogue category. */
export function classifyLineItemCode(itemCode: string | null | undefined): AmendmentLane {
  return classifyLine({ itemCode });
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
 * Split one validated submission into its lane halves. `lineIdentity` resolves
 * the identity of the line a change targets (ADD → the requested new_item_code
 * and its catalogue category; SPEC/QTY/REMOVE → the SO line's current item_code
 * + item_group, looked up by the caller). item_group or category is what routes
 * a bare-code service line to DELIVERY.
 *
 * `linePriceOnly` answers, for a line the caller resolved as a product line,
 * whether the ONLY thing it moves is the sell price / discount (SKU / colour /
 * qty / remark unchanged); `priceLaneEnabled` is true only on a
 * PRICE_LANE_COMPANY_CODES company. When both hold, that product line carves off into
 * the PRICE lane instead of LINES. Both are REQUIRED so the price carve-out is
 * never a silent default — a caller with no price lane passes `() => false` and
 * `false`, and the split is exactly the two-lane behaviour it always had.
 */
export function splitAmendmentByLane<L>(
  headerChanges: Record<string, string | null>,
  lines: L[],
  lineIdentity: (line: L) => LineLaneIdentity,
  linePriceOnly: (line: L) => boolean,
  priceLaneEnabled: boolean,
): LaneSplit<L> {
  const mk = () => ({ headerChanges: {} as Record<string, string | null>, headerKeys: [] as string[], lines: [] as L[] });
  const perLane: LaneSplit<L>['perLane'] = { LINES: mk(), DELIVERY: mk(), PRICE: mk() };

  for (const [k, v] of Object.entries(headerChanges)) {
    // Header keys only ever answer LINES or DELIVERY — a price is a line-level
    // value, so classifyHeaderKey never routes to PRICE.
    const lane = classifyHeaderKey(k);
    perLane[lane].headerChanges[k] = v;
    perLane[lane].headerKeys.push(k);
  }
  for (const line of lines) {
    let lane = classifyLine(lineIdentity(line));
    // A price-only product-line change is Finance's, not the Purchaser's, on a
    // price-lane company: the sell price carries nothing for the PO to follow.
    // Service lines are already DELIVERY and never reach this branch.
    if (lane === 'LINES' && priceLaneEnabled && linePriceOnly(line)) lane = 'PRICE';
    perLane[lane].lines.push(line);
  }

  const lanes = (['LINES', 'DELIVERY', 'PRICE'] as AmendmentLane[]).filter(
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
