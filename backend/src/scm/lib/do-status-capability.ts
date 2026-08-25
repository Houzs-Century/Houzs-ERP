import {
  hasPositionCapability,
  type PositionCapabilityCaller,
} from "../../services/positionCapabilities";

// The delivery-completion states a driver drives after dispatch — the POD chain.
// Kept as its own set because these are the transitions that need an OWNERSHIP
// check (the caller may only complete THEIR OWN delivery), unlike LOADED /
// DISPATCHED which are warehouse / fleet actions the capability alone admits.
// A DELIBERATELY DIFFERENT PARTITION, not a copy of a shared set: the post-
// dispatch delivery-COMPLETION states a driver signs off. It is DO_STOCK_OUT_
// STATES minus the warehouse/dispatch/finance rungs (LOADED, DISPATCHED,
// INVOICED) — no shared export names this subset, and it must stay a subset
// even if the shared set gains a member, so it is stated here on purpose.
export const POD_STATES: ReadonlySet<string> = new Set(
  // eslint-disable-next-line no-restricted-syntax -- POD subset, see above
  ["IN_TRANSIT", "SIGNED", "DELIVERED"],
);

/**
 * The operational capability a caller admitted via the area-guard writeBypass
 * (no scm.sales.delivery access) needs for a status transition:
 *   · LOADED                              → scm.do.load     (warehouse confirm — the stock OUT)
 *   · DISPATCHED + the POD chain          → scm.do.dispatch (the driver's forward chain)
 *   · anything else                       → null            (no capability admits it)
 * POD reuses scm.do.dispatch (owner: the driver dispatches AND signs off the
 * delivery); the difference is that POD additionally requires ownership, checked
 * separately at the endpoint once the DO's crew is known.
 */
export function statusCapabilityFor(toStatus: string): string | null {
  if (toStatus === "LOADED") return "scm.do.load";
  if (toStatus === "DISPATCHED" || POD_STATES.has(toStatus)) return "scm.do.dispatch";
  return null;
}

/**
 * The CAPABILITY-half refusal (or null to allow) for a bypassed caller: does
 * this position hold the verb the transition needs? Ownership (POD only) is a
 * separate, later check that needs the DO's crew. Fails closed — an unknown
 * status or a caller without the verb is refused.
 */
export function statusCapabilityRefusal(
  caller: PositionCapabilityCaller | null | undefined,
  toStatus: string,
): { error: string; reason: string } | null {
  const need = statusCapabilityFor(toStatus);
  if (need && hasPositionCapability(caller, need)) return null;
  return {
    error: "capability_required",
    reason:
      toStatus === "LOADED"
        ? "Confirming loading needs the Load permission for your position."
        : "Dispatching or completing a delivery needs the Dispatch permission for your position.",
  };
}
