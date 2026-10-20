// ----------------------------------------------------------------------------
// assr-pickup-tracking — the Pickup / Return step's own tracking fields
// (HC-0129): pickup status, actual pickup date, pickup PIC, item location.
// The scheduled (ETA) date is the existing customer_pickup_at.
//
// Byte-identical at backend/src/scm/shared/assr-pickup-tracking.ts and
// frontend/src/vendor/scm/lib/assr-pickup-tracking.ts (the frontend canonical
// test fails on any difference). No imports, for the same reason.
// ----------------------------------------------------------------------------

export const PICKUP_STATUS_OPTIONS = ["pending", "scheduled", "completed"] as const;
export const ITEM_LOCATION_OPTIONS = ["customer", "warehouse", "supplier"] as const;
export const PICKUP_PIC_MAX = 120;

const LABELS: Record<string, string> = {
  pending: "Pending", scheduled: "Scheduled", completed: "Completed",
  customer: "Customer", warehouse: "Warehouse", supplier: "Supplier",
};
export const pickupTrackingLabel = (v: string): string => LABELS[v] ?? v;
/** Select options with a blank "not set" first, for screens whose select has none of its own. */
export const pickupTrackingOptions = (list: readonly string[]): { value: string; label: string }[] =>
  [{ value: "", label: "—" }, ...list.map((v) => ({ value: v, label: pickupTrackingLabel(v) }))];

/** Why a PATCH body's tracking fields are refused, or null when they are fine. Absent and null pass. */
export function pickupTrackingError(body: Record<string, unknown>): string | null {
  const has = (k: string) => body[k] !== undefined && body[k] !== null;
  if (has("pickup_status") && !(PICKUP_STATUS_OPTIONS as readonly unknown[]).includes(body.pickup_status))
    return `pickup_status must be one of ${PICKUP_STATUS_OPTIONS.join(", ")}`;
  if (has("item_location") && !(ITEM_LOCATION_OPTIONS as readonly unknown[]).includes(body.item_location))
    return `item_location must be one of ${ITEM_LOCATION_OPTIONS.join(", ")}`;
  if (has("actual_pickup_at") && !(typeof body.actual_pickup_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.actual_pickup_at)))
    return "actual_pickup_at must be a YYYY-MM-DD date";
  if (has("pickup_pic") && !(typeof body.pickup_pic === "string" && body.pickup_pic.length <= PICKUP_PIC_MAX))
    return `pickup_pic must be text of at most ${PICKUP_PIC_MAX} characters`;
  return null;
}
