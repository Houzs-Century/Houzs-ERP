
export const SVC_DELIVERY = 'SVC-DELIVERY';
export const SVC_DELIVERY_CROSS = 'SVC-DELIVERY-CROSS';
export const SVC_DELIVERY_ADD = 'SVC-DELIVERY-ADD';
export const SVC_DISPOSE_MATTRESS = 'SVC-DISPOSE-MATTRESS';
export const SVC_DISPOSE_BEDFRAME = 'SVC-DISPOSE-BEDFRAME';
export const SVC_LIFT_CARRY = 'SVC-LIFT-CARRY';

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
