
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
