// ---------------------------------------------------------------------------
// assr-pickup-default — the customer-pickup leg of a Service Case is own-team
// work until someone says otherwise.
//
// The Pickup / Return stage begins on the customer-pickup leg (collect the item
// FROM the customer). That leg reaches Delivery Planning and the HC Delivery
// sheet ONLY when its own-team marker `pickup_by='customer'` is set
// (service-case.md). So a case switched to "Pending Customer Pickup" with
// pickup_by still null sat invisible on the board and the pickup never reached a
// driver. When a case lands on that leg and nobody has yet named WHO collects,
// default it to our own team so the pickup surfaces as a driver job. An explicit
// supplier / 3PL choice (or a pickup_by sent in the same request) is never
// overridden. Lives in its own module so the (over-ceiling) services/assr.ts
// call sites stay one line each.
// ---------------------------------------------------------------------------

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
