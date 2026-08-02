// ---------------------------------------------------------------------------
// rate-rule-taxonomy.ts — which rate rule prices which kind of job, and how the
// flat rule list groups on screen.
//
// WHY. Owner, 2026-08-02: "它应该要分成种类" — delivery, setup/dismantle,
// service calls, outstation — and "我的 job type 有什么类型，它就应该有什么类型。
// 并且 job type 的名字也要跟我们的 DP 那一边是一样的".
//
// Until now the twelve rule types were ONE alphabetically-sorted list with no
// grouping in the data model, none in the UI, and no relationship to the jobs
// the fleet actually dispatches. The grouping existed only as prose in a
// migration comment. This file makes it code, so the editor, the calculator and
// any future report all read the same answer.
//
// DERIVED, NEVER STORED. A `category` column would be a second source of truth
// for something rule_type already determines; the first time they disagreed,
// money would follow the wrong one.
//
// THE NAMES ARE THE DP NAMES. PICKUP, SERVICE, SETUP, DISMANTLE, INSPECTION and
// SUPPLIER_PICKUP are spelled exactly as scm.trip_stop_type spells them, on the
// owner's instruction. Where a rule has no dispatchable counterpart that is
// recorded here explicitly rather than left to be rediscovered.
// ---------------------------------------------------------------------------

/**
 * Every job the fleet can be DISPATCHED to do — this file's copy of the
 * `scm.trip_stop_type` enum (mig 0053, extended by 0128 SUPPLIER_PICKUP and
 * 0165 INSPECTION).
 *
 * It is a copy, and a copy can lie. `npm run audit:job-types` reads the
 * migrations and fails if this list and the enum have drifted — the test below
 * only proves the rules COVER this list, which is worthless if the list itself
 * is stale.
 */
export const DISPATCHABLE_JOB_TYPES = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP', 'INSPECTION',
] as const;
export type DispatchableJobType = (typeof DISPATCHABLE_JOB_TYPES)[number];

/** Every rule type a card can carry. Mirrors the CHECK in mig 0243. */
export const RATE_RULE_TYPES = [
  'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET',
  'OUTSTATION', 'OUTSTATION_TRIP',
  'SETUP', 'DISMANTLE',
  'SERVICE', 'PICKUP', 'INSPECTION', 'SUPPLIER_PICKUP', 'TRANSFER',
  'DISPOSE',
] as const;
export type RateRuleType = (typeof RATE_RULE_TYPES)[number];

/** The four groups the owner named. */
export const RATE_RULE_CATEGORIES = ['DELIVERY', 'SITE_WORK', 'SERVICE_CALL', 'OUTSTATION'] as const;
export type RateRuleCategory = (typeof RATE_RULE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<RateRuleCategory, string> = {
  DELIVERY: 'Delivery',
  SITE_WORK: 'Setup & dismantle',
  SERVICE_CALL: 'Service calls',
  OUTSTATION: 'Outstation',
};

export const CATEGORY_HINT: Record<RateRuleCategory, string> = {
  DELIVERY: 'What it costs to deliver the goods — priced by position, with sofas on their own bracket.',
  SITE_WORK: 'Work done at the address, charged per occurrence.',
  SERVICE_CALL: 'A trip made for a reason other than delivering an order.',
  OUTSTATION: 'Distance surcharges by destination zone. Per order, per trip, or both.',
};

/** rule type -> its group. The single place this mapping exists. */
export const RULE_CATEGORY: Record<RateRuleType, RateRuleCategory> = {
  POSITIONAL_TIER: 'DELIVERY',
  OVERAGE: 'DELIVERY',
  SOFA_BRACKET: 'DELIVERY',
  /* Dispose rides a delivery — you take the old mattress away while dropping
     the new one — so it is priced with the delivery, not as a service call. */
  DISPOSE: 'DELIVERY',
  SETUP: 'SITE_WORK',
  DISMANTLE: 'SITE_WORK',
  SERVICE: 'SERVICE_CALL',
  PICKUP: 'SERVICE_CALL',
  INSPECTION: 'SERVICE_CALL',
  SUPPLIER_PICKUP: 'SERVICE_CALL',
  TRANSFER: 'SERVICE_CALL',
  OUTSTATION: 'OUTSTATION',
  OUTSTATION_TRIP: 'OUTSTATION',
};

export const RULE_LABEL: Record<RateRuleType, string> = {
  POSITIONAL_TIER: 'Positional tier',
  OVERAGE: 'Cap overage',
  SOFA_BRACKET: 'Sofa bracket',
  DISPOSE: 'Dispose',
  SETUP: 'Setup',
  DISMANTLE: 'Dismantle',
  SERVICE: 'Service',
  PICKUP: 'Pickup',
  INSPECTION: 'Inspection',
  SUPPLIER_PICKUP: 'Supplier pickup',
  TRANSFER: 'Transfer',
  OUTSTATION: 'Outstation zone (per order)',
  OUTSTATION_TRIP: 'Outstation trip (fixed, per trip)',
};

/**
 * The DP job type this rule prices, when there is one.
 *
 * Spelled exactly as `scm.trip_stop_type` spells it. `null` means the rule
 * prices something that is NOT dispatched as its own job:
 *
 *  - the DELIVERY group prices a DELIVERY job, but through three cooperating
 *    rules rather than one named after it;
 *  - DISPOSE and TRANSFER are add-ons billed on whatever job carried them —
 *    they were checked against the job list and are absent by design, not by
 *    oversight;
 *  - the OUTSTATION rules are surcharges on any job, not a job.
 */
export const RULE_JOB_TYPE: Record<RateRuleType, string | null> = {
  POSITIONAL_TIER: 'DELIVERY',
  OVERAGE: 'DELIVERY',
  SOFA_BRACKET: 'DELIVERY',
  DISPOSE: null,
  SETUP: 'SETUP',
  DISMANTLE: 'DISMANTLE',
  SERVICE: 'SERVICE',
  PICKUP: 'PICKUP',
  INSPECTION: 'INSPECTION',
  SUPPLIER_PICKUP: 'SUPPLIER_PICKUP',
  TRANSFER: null,
  OUTSTATION: null,
  OUTSTATION_TRIP: null,
};

/** Rule types in category order, then in the order declared above — so the
 *  editor and the calculator present them the same way. Replaces the
 *  alphabetical sort that interleaved outstation with sofa brackets. */
export function rulesByCategory(): Array<{ category: RateRuleCategory; types: RateRuleType[] }> {
  return RATE_RULE_CATEGORIES.map((category) => ({
    category,
    types: RATE_RULE_TYPES.filter((t) => RULE_CATEGORY[t] === category),
  }));
}

/** Which DP job types can be PRICED by at least one rule. Used to answer "we
 *  dispatch this — can we charge for it?" without hand-maintaining a list. */
export function pricedJobTypes(): string[] {
  return [...new Set(Object.values(RULE_JOB_TYPE).filter((v): v is string => v !== null))];
}
