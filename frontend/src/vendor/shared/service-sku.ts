// ----------------------------------------------------------------------------
// service-sku — SERVICE SKU vocabulary + line predicates (single source of truth).
//
// P1 of the SO all-charges-as-SKU-lines spec
// (docs/specs/2026-06-04-so-sku-lines-and-sync-spec.md §4.6/R6, §8 D2+D9).
// Delivery fees and POS add-ons (dispose / lift) become SERVICE-category SKU
// lines on Sales Orders. SERVICE lines ride the whole document chain —
// SO → DO → SI, data AND print (D2 final, Loo 2026-06-05) — but they are NOT
// goods:
//   · never allocated stock / never gate SO readiness,
//   · never produce inventory movements (DO ship-OUT, DR return-IN, resyncs),
//   · never returnable on a Delivery Return,
//   · never MRP demand.
//
// Every guard imports THESE predicates. Don't re-derive 'SVC-' / 'service'
// string checks at call sites — vocabulary drift is how the dash-vs-parens
// compartment-code split happened.
// ----------------------------------------------------------------------------

/* SKU codes seeded in P2 (§8-D9 — Loo picked the SVC-* prefix). The catalog
   row (mfg_products) carries category='SERVICE'; SO/DO/SI/DR lines carry
   item_group='service' (SoLineCard lowercases the product category). */
export const SVC_DELIVERY = 'SVC-DELIVERY';
export const SVC_DELIVERY_CROSS = 'SVC-DELIVERY-CROSS';
export const SVC_DELIVERY_ADD = 'SVC-DELIVERY-ADD';
export const SVC_DISPOSE_MATTRESS = 'SVC-DISPOSE-MATTRESS';
export const SVC_DISPOSE_BEDFRAME = 'SVC-DISPOSE-BEDFRAME';
export const SVC_LIFT_CARRY = 'SVC-LIFT-CARRY';

/* Loo 2026-06-10 — per-floor lift tiers. Each floor 1..5 is its own SKU so a
   Backend-keyed SO prices itself (pick the floor, qty = pieces carried) and
   the free band (floors 1–2) still SHOWS on the SO as an RM0 line instead of
   silently vanishing. The legacy SVC-LIFT-CARRY stays in the catalog for
   history and as the fallback above the tier ceiling. Seeded by migration
   0163 — F1/F2 at 0, F3 RM100, F4 RM200, F5 RM300 per item (matches
   max(floors−2,0) × the addons rate). */
export const MAX_LIFT_TIER_FLOOR = 5;
const FLOOR_ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th'];
/** Floor 1..MAX_LIFT_TIER_FLOOR → its tier SKU code (SVC-LIFT-CARRY-F3). */
export const svcLiftCarryTierSku = (floors: number): string =>
  `${SVC_LIFT_CARRY}-F${floors}`;
/** The tier SKU's catalog name — keep in lockstep with the 0163 seeds; SO
 *  lines use this as their stable description. */
export const svcLiftCarryTierName = (floors: number): string =>
  `Lift access / stair carry — ${FLOOR_ORDINALS[floors] ?? `${floors}th`} floor`;
/** Migration 0157 (Loo 2026-06-06) — generic execution SKU for any handover
 *  add-on WITHOUT a dedicated SVC-* code above. The line description carries
 *  the add-on's label, so an admin-created add-on books + prints correctly
 *  with zero code change. */
export const SVC_ADDON = 'SVC-ADDON';

/** Delivery-fee SERVICE SKUs — amounts are server-computed
 *  (computeSoDeliveryFee / operator-entered additional fee), §4.1. */
export const SERVICE_DELIVERY_FEE_CODES = [
  SVC_DELIVERY,
  SVC_DELIVERY_CROSS,
  SVC_DELIVERY_ADD,
] as const;

/** Execution SERVICE SKUs — the driver performs these on site
 *  (collect the old mattress/bedframe, stair-carry), §4.2 + D6.
 *  SVC-ADDON is the generic bucket for admin-created handover add-ons. */
export const SERVICE_EXECUTION_CODES = [
  SVC_DISPOSE_MATTRESS,
  SVC_DISPOSE_BEDFRAME,
  SVC_LIFT_CARRY,
  SVC_ADDON,
] as const;

export const SERVICE_SKU_PREFIX = 'SVC-';

const norm = (v: string | null | undefined): string => (v ?? '').trim().toUpperCase();

/** item_group signal — SO/DO/SI/DR lines store 'service' (plain text column).
 *  `.includes` mirrors normCat in mfg-sales-orders.ts, generous on purpose. */
export function isServiceItemGroup(itemGroup: string | null | undefined): boolean {
  return norm(itemGroup).includes('SERVICE');
}

/** mfg_products.category signal — the authoritative catalog enum value. */
export function isServiceCategory(category: string | null | undefined): boolean {
  return norm(category) === 'SERVICE';
}

/** item_code signal — every seeded SERVICE SKU code starts with SVC-. */
export function isServiceSkuCode(itemCode: string | null | undefined): boolean {
  const c = norm(itemCode);
  return c.length > SERVICE_SKU_PREFIX.length && c.startsWith(SERVICE_SKU_PREFIX);
}

export interface ServiceLineSignals {
  itemGroup?: string | null;
  itemCode?: string | null;
  /** mfg_products.category when the caller has it joined; omit otherwise. */
  category?: string | null;
}

/** A document line is a SERVICE line when ANY signal says so. Callers pass
 *  whatever signals they have — item_group rides on every line table, the
 *  code prefix needs no lookup, category is the strongest when available. */
export function isServiceLine(line: ServiceLineSignals): boolean {
  return (
    isServiceItemGroup(line.itemGroup) ||
    isServiceCategory(line.category) ||
    isServiceSkuCode(line.itemCode)
  );
}

/** Fee-type SERVICE code (SVC-DELIVERY*) — distinguishes the delivery-fee
 *  family from execution services. Prefix-matched so a future
 *  SVC-DELIVERY-EAST-MALAYSIA classifies correctly without a code change. */
export function isDeliveryFeeServiceCode(itemCode: string | null | undefined): boolean {
  return norm(itemCode).startsWith(SVC_DELIVERY);
}

/** Execution-type SERVICE code — a SERVICE SKU that is not a delivery fee
 *  (dispose / lift): the driver has work to do at the door. */
export function isExecutionServiceCode(itemCode: string | null | undefined): boolean {
  return isServiceSkuCode(itemCode) && !isDeliveryFeeServiceCode(itemCode);
}
