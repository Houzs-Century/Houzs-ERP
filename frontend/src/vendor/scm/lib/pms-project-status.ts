// ----------------------------------------------------------------------------
// pms-project-status — CANONICAL project STATUS values + the payment/deposit
// pill vocabulary. NO React, no I/O. Imported by desktop `Projects.tsx` and
// mobile `MobilePMS.tsx`.
//
// Distinct from `pms-status.ts`, which owns the workflow STAGE vocabulary
// (draft -> setup -> live -> dismantle -> completed). `status` is the
// boss-facing lifecycle added by mig 088; it drives the calendar tint and the
// list chips.
//
// WHY IT EXISTS. Desktop held a module constant; mobile held three literal
// option elements. The values agreed, so there was no live bug — but the next
// status added would have appeared on desktop and silently not on the phone.
// The sibling list had ALREADY drifted that way: the payment pill for
// `fully_paid` read "Fully paid" on desktop and "Paid" on mobile.
//
// COLOURS ARE NOT HERE, deliberately — the same split `pms-status.ts` uses.
// Desktop maps these values onto Tailwind chip/ring classes and a calendar hex;
// mobile uses inline styles. Only the value-to-label contract is shared, so the
// two surfaces cannot disagree about WHICH statuses exist or what they are
// called, while each keeps its own palette.
// ----------------------------------------------------------------------------

export type ProjectStatus = "confirmed" | "pending" | "cancelled";

export const PROJECT_STATUS_OPTIONS: Array<{ value: ProjectStatus; label: string }> = [
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "cancelled", label: "Cancelled" },
];

/** Payment / deposit pill rows (mig 090) render as multi-state pills instead of
 *  the done/pending circle. `pill_value` is stored through the ordinary
 *  checklist PATCH; the row's status stays 'na' so it stays off the progress
 *  bar.
 *
 *  "Fully paid" and not "Paid" — desktop's wording, kept because it names the
 *  stored value (`fully_paid`) and distinguishes it from a part payment. */
export const PAYMENT_PILL_OPTIONS: Record<string, Array<[string, string]>> = {
  rental_payment: [["none", "N/A"], ["unpaid", "Pending"], ["fully_paid", "Fully paid"]],
  deposit: [["none", "N/A"], ["unpaid", "Pending"], ["refunded", "Refunded"]],
};

/** The options for a pill row. Anything that is not `rental_payment` is a
 *  deposit-shaped pill — the branch both surfaces already had. */
export function paymentPillOptions(pillKind: string | null | undefined): Array<[string, string]> {
  return pillKind === "rental_payment"
    ? PAYMENT_PILL_OPTIONS.rental_payment
    : PAYMENT_PILL_OPTIONS.deposit;
}
