
/** 'customer' when the case is landing on the customer-pickup leg with no pickup
 *  owner yet; null otherwise (nothing to default). */
export function customerPickupOwnTeamDefault(
  newSubStatus: string | null | undefined,
  currentPickupBy: string | null | undefined,
): "customer" | null {
  return newSubStatus === "pending_customer_pickup" && !String(currentPickupBy ?? "").trim()
    ? "customer"
    : null;
}

/** Append the `pickup_by='customer'` default to an UPDATE's SET/bind pair when
 *  the customer-pickup leg needs it. No-op otherwise, so the call site is one
 *  line in either entry point (transitionStage / patchAssrCase). */
export function pushCustomerPickupDefault(
  sets: string[],
  binds: unknown[],
  newSubStatus: string | null | undefined,
  currentPickupBy: string | null | undefined,
): void {
  if (customerPickupOwnTeamDefault(newSubStatus, currentPickupBy)) {
    sets.push("pickup_by = ?");
    binds.push("customer");
  }
}
