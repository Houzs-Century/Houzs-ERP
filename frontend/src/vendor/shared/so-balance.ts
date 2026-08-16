// ----------------------------------------------------------------------------
// so-balance — TOTAL minus PAID, and the ONE condition under which the answer
// is allowed to be negative.
//
// WHY THIS IS A MODULE AND NOT AN EXPRESSION. `total - paid` was written out by
// hand in five places, and every one of them wrapped it in a floor —
// `GREATEST(..., 0)` in the payment-totals view, `Math.max(0, ...)` in the SO
// detail route, in `deriveBalance`, in the PaymentsTable summary and in the SO
// PDF. The floor made an over-collection unrepresentable, so the ERP refused
// the money instead of showing it, and on 2026-08-16 an operator recorded
// RM 2,250 against a RM 4,000 order by RAISING a line price to RM 250 first.
// Money went into item value because the balance had nowhere to go.
//
// THE CONDITION, and it is the whole reason this is not just "drop the floor".
// Measured on production 2026-08-16 (backend/scripts/probe-so-overpay.mjs, run
// 31938486974): of 2,824 non-cancelled sales orders, **2,739 carry
// `total_revenue_centi = 0`** — the AutoCount cutover never populated it — and
// 2,687 of those have a positive `local_total_centi`. Subtracting the payments
// ledger from a zero total yields a large negative on 2,121 orders that are in
// fact still OWED money (RM 9,260,500 of it). A blind unfloor would paint every
// one of them as an over-collection.
//
// So a negative is asserted only where the total is KNOWN — `totalCenti > 0`.
// Where the total is 0 or missing the ERP cannot tell "this order is worth
// nothing and the customer overpaid" from "nobody ever wrote down what this
// order is worth", and it must not claim a credit it cannot evidence. That case
// keeps the historical floor, so the 2,121 orders above read exactly as they
// read today.
//
// Sen/centi integers throughout. No floats, no rounding: every input is already
// an integer number of sen and subtraction preserves that.
// ----------------------------------------------------------------------------

/**
 * The order's SIGNED balance in sen: positive = still owed, negative = the
 * customer has paid more than the order is worth.
 *
 * Negative only when `totalCenti > 0` (see the header). This is the number a
 * human has agreed with the customer, and it is what belongs on a screen, on
 * the customer-facing print and in AutoCount's `UDF_BALANCE` — AutoCount's own
 * extract carries negatives on 47 of its 13,015 SO headers, so the account book
 * can hold a credit; it was only the ERP that could not say one.
 */
export function soBalanceOf(totalCenti: number, paidCenti: number): number {
  const signed = totalCenti - paidCenti;
  return totalCenti > 0 ? signed : Math.max(0, signed);
}

/**
 * The RECEIVABLE in sen — never negative.
 *
 * Deliberately separate from `soBalanceOf`, because an aggregate and a screen
 * want different answers. One customer's RM 250 credit must not quietly cancel
 * RM 250 of somebody else's debt inside an Outstanding total, and a delivery
 * release gate asking "what must the driver still collect" is answered by 0,
 * never by a negative. Anything that SUMS across orders, or gates on "is there
 * money left to collect", uses this.
 */
export function soReceivableOf(totalCenti: number, paidCenti: number): number {
  return Math.max(0, soBalanceOf(totalCenti, paidCenti));
}

/**
 * How much MORE than the order is worth has been collected, in sen; 0 when the
 * order is not over-collected. The mirror of `soReceivableOf`.
 */
export function soOverCollectedOf(totalCenti: number, paidCenti: number): number {
  return Math.max(0, -soBalanceOf(totalCenti, paidCenti));
}
