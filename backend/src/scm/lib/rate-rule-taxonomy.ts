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
 * `scm.trip_stop_type` enum (mig 0053, extended by 0128 SUPPLIER_PICKUP, 0165
 * INSPECTION and 0250 TRANSFER + LORRY_SERVICE).
 *
 * It is a copy, and a copy can lie. `npm run audit:job-types` reads the
 * migrations and fails if this list and the enum have drifted — the test below
 * only proves the rules COVER this list, which is worthless if the list itself
 * is stale.
 */
export const DISPATCHABLE_JOB_TYPES = [
  'DELIVERY', 'PICKUP', 'SERVICE', 'SETUP', 'DISMANTLE', 'SUPPLIER_PICKUP', 'INSPECTION',
  /* Owner 2026-08-03, the nine-job-type list. LORRY_SERVICE is dispatchable but
     NOT billable — the workshop bills US, and that spend lives on
     scm.lorry_work_orders — so it is named in NON_BILLABLE_JOB_TYPES in
     backend/scripts/check-job-type-parity.mjs rather than given a rate rule
     nobody would ever price a customer with. */
  'TRANSFER', 'LORRY_SERVICE',
] as const;
export type DispatchableJobType = (typeof DISPATCHABLE_JOB_TYPES)[number];

/**
 * Dispatchable jobs that must NOT be priced, and why.
 *
 * "Every job we dispatch must be billable" holds only where a CUSTOMER is on
 * the other side of it. LORRY_SERVICE is the first job type where the money
 * runs the other way: we send our own lorry to a workshop, the workshop bills
 * US, and that spend is recorded on scm.lorry_work_orders (mig 0204/0241). A
 * rate rule for it would be one no card could ever apply — a decoration that
 * makes the coverage check pass without meaning anything.
 *
 * Read by BOTH the test in this folder and `npm run audit:job-types`, so an
 * exemption cannot be granted to one and not the other. Adding an entry means
 * writing down who is not being billed; the audit rejects an entry for a job
 * type that does not exist, or one that some rule prices after all.
 */
export const NON_BILLABLE_JOB_TYPES = ['LORRY_SERVICE'] as const;

/** Every rule type a card can carry. Mirrors the CHECK in mig 20261124T2230. */
export const RATE_RULE_TYPES = [
  'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET',
  'OUTSTATION', 'OUTSTATION_TRIP',
  'SETUP', 'DISMANTLE',
  'SERVICE', 'PICKUP', 'INSPECTION', 'SUPPLIER_PICKUP', 'TRANSFER',
  'DISPOSE',
  'DO_CHARGE',
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
  DELIVERY: 'Prices the Delivery order job: by position, with sofas on their own bracket, and named charges on each DO (an amount, or a % of its goods value).',
  SITE_WORK: 'Prices the Setup and Dismantle jobs, each time one is done.',
  SERVICE_CALL: 'Prices the Supplier, Transfer item and ASSR (Inspection, Pickup, Service) jobs, each time one is done.',
  OUTSTATION: 'A surcharge by the area a job goes to: its postcode zone or a town. Per order, per trip, or both.',
};

/** rule type -> its group. The single place this mapping exists. */
export const RULE_CATEGORY: Record<RateRuleType, RateRuleCategory> = {
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
  DO_CHARGE: 'DELIVERY',
};

export const RULE_LABEL: Record<RateRuleType, string> = {
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
  DO_CHARGE: 'Per DO charge (RM or % of goods)',
};

/**
 * The DP job type this rule prices, when there is one.
 *
 * Spelled exactly as `scm.trip_stop_type` spells it. `null` means the rule
 * prices something that is NOT dispatched as its own job:
 *
 *  - the DELIVERY group prices a DELIVERY job, but through three cooperating
 *    rules rather than one named after it;
 *  - DISPOSE is an add-on billed on whatever job carried it — checked against
 *    the job list and absent by design, not by oversight;
 *  - the OUTSTATION rules are surcharges on any job, not a job.
 *
 * TRANSFER USED TO BE ONE OF THOSE ADD-ONS and no longer is. Mig 0243 read it
 * as a line on the job that carried it; the owner's 2026-08-03 job-type list
 * made "Transfer item" a job the fleet is dispatched to do (mig 0250), so the
 * rule of the same name now names it. Same rule, same CHECK, same money — it
 * just stopped being homeless.
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
  TRANSFER: 'TRANSFER',
  OUTSTATION: null,
  OUTSTATION_TRIP: null,
  DO_CHARGE: 'DELIVERY',
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
