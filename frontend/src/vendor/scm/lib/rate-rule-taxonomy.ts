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
  DELIVERY: 'Prices the Delivery order job: by position, with sofas on their own bracket.',
  SITE_WORK: 'Prices the Setup and Dismantle jobs, each time one is done.',
  SERVICE_CALL: 'Prices the Supplier, Transfer item and ASSR (Inspection, Pickup, Service) jobs, each time one is done.',
  OUTSTATION: 'A surcharge by the area a job goes to: its postcode zone or a town. Per order, per trip, or both.',
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
  SERVICE: 'ASSR - Service',
  PICKUP: 'ASSR - Pickup',
  INSPECTION: 'ASSR - Inspection',
  SUPPLIER_PICKUP: 'Supplier',
  TRANSFER: 'Transfer item',
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

/**
 * The jobs a card can price, in the order Delivery Planning's New DP Order menu
 * lists them (owner 2026-11-18: "the rate card is bound to all my jobs"). The
 * dispatchable jobs less the non-billable ones (LORRY_SERVICE); spelled as
 * `scm.trip_stop_type` spells them. The three ASSR legs ride PICKUP (customer
 * pickup), INSPECTION and SERVICE (the delivery back, which DP calls ASSR - Service).
 */
export const BILLABLE_JOB_TYPES = [
  'DELIVERY', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP', 'TRANSFER', 'INSPECTION', 'PICKUP', 'SERVICE',
] as const;
export type BillableJobType = (typeof BILLABLE_JOB_TYPES)[number];

/** A job's name as Delivery Planning shows it. */
export const JOB_LABEL: Record<BillableJobType, string> = {
  DELIVERY: 'Delivery order',
  SETUP: 'Setup',
  DISMANTLE: 'Dismantle',
  SUPPLIER_PICKUP: 'Supplier',
  TRANSFER: 'Transfer item',
  INSPECTION: 'ASSR - Inspection',
  PICKUP: 'ASSR - Pickup',
  SERVICE: 'ASSR - Service',
};

/**
 * Which jobs an outstation price adds to when the rule names none: delivery
 * orders. That is all it ever reached before the setting existed — the 3PL
 * invoices tab and the trip reconciliation priced delivery orders alone — so a
 * card saved before it prices exactly as it did.
 */
export const OUTSTATION_DEFAULT_APPLIES_TO: readonly BillableJobType[] = ['DELIVERY'];

const BILLABLE_SET: ReadonlySet<string> = new Set(BILLABLE_JOB_TYPES);

/** The jobs an outstation rule applies to, read from its stored `params.appliesTo`.
 *  Unknown names are dropped; nothing left reads as the default. PURE. */
export function appliesToOf(params: unknown): BillableJobType[] {
  const raw = params && typeof params === 'object' ? (params as Record<string, unknown>).appliesTo : null;
  const list = Array.isArray(raw) ? raw.map((v) => String(v).toUpperCase()).filter((v) => BILLABLE_SET.has(v)) : [];
  const picked = BILLABLE_JOB_TYPES.filter((t) => list.includes(t));
  return picked.length > 0 ? picked : [...OUTSTATION_DEFAULT_APPLIES_TO];
}
