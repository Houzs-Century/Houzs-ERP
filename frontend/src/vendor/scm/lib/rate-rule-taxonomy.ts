// ---------------------------------------------------------------------------
// rate-rule-taxonomy.ts (frontend mirror)
//
// The rule -> category -> label mapping, kept byte-identical to
// backend/src/scm/lib/rate-rule-taxonomy.ts. Owner, 2026-08-02: "它应该要分成
// 种类" and "job type 的名字也要跟我们的 DP 那一边是一样的".
//
// WHY A MIRROR AND NOT AN IMPORT. The frontend cannot import from backend/ —
// separate tsconfig projects, separate build. The existing precedent in this
// repo is the same: DP_JOB_TYPES is declared on both sides.
//
// WHAT KEEPS THEM HONEST. `npm run audit:job-types` reads BOTH files and fails
// on any divergence. A mirror with no check is just a copy waiting to lie.
// ---------------------------------------------------------------------------

export const RATE_RULE_TYPES = [
  'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET',
  'OUTSTATION', 'OUTSTATION_TRIP',
  'SETUP', 'DISMANTLE',
  'SERVICE', 'PICKUP', 'INSPECTION', 'SUPPLIER_PICKUP', 'TRANSFER',
  'DISPOSE',
] as const;
export type RateRuleTypeT = (typeof RATE_RULE_TYPES)[number];

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

export const RULE_CATEGORY: Record<RateRuleTypeT, RateRuleCategory> = {
  POSITIONAL_TIER: 'DELIVERY',
  OVERAGE: 'DELIVERY',
  SOFA_BRACKET: 'DELIVERY',
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

export const RULE_LABEL: Record<RateRuleTypeT, string> = {
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

/** Rule types grouped, in category order then declared order — so the editor's
 *  dropdown, the rules table and the calculator all present them identically.
 *  Replaces the alphabetical sort that interleaved outstation with sofa
 *  brackets and setup with service. */
export function rulesByCategory(): Array<{ category: RateRuleCategory; types: RateRuleTypeT[] }> {
  return RATE_RULE_CATEGORIES.map((category) => ({
    category,
    types: RATE_RULE_TYPES.filter((t) => RULE_CATEGORY[t] === category),
  }));
}
