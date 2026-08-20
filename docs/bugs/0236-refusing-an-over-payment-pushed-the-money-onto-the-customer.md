## Refusing an over-payment pushed the money onto the customer's line items [high]

<!-- area: Sales orders + pricing -->

**Symptom.** Owner, 2026-08-16: 「我的 payment 是不能超收的…如果我多收 250，
它不是应该 show balance negative 250 代表我超收吗？但它现在是直接把我的 item
upgrade 上去，加多了 250 块」. A receipt larger than the outstanding total was
refused, and the order's line value grew by the excess instead.

**Root cause (traced).** NOT an automatic write — no code path adds a payment's
excess to a line, and production agrees: price rises whose delta equals a
payment amount on the same order = 0 across the whole book
(probe-so-overpay.mjs, run 31938039273 section 5). The guard itself was the
cause. POST/PATCH /:docNo/payments refused Σ(ledger) + this payment >
total_revenue_centi, so an operator holding cash the customer had already paid
had exactly one way to bank it: re-price the ORDER until the total covered it.
On HC-SO-2608-002 that is the audit trail — UPDATE_LINE at 08:26:22 put RM 250
of "Right Drawer" special on a JAGER-(K) line (unitPriceCenti 0 -> 25000), and
the RM 2,250 payment landed 76 seconds later at 08:27:38, accepted because the
total was now exactly 425000. The order silently grew a drawer nobody sold, and
an item is what gets manufactured and delivered.

**Fix.** Over-collection is allowed: the guard is deleted from both payment
routes with the two lookups it needed. so-outstanding.ts gains soBalanceCenti
(signed) beside soOutstandingCenti (still clamped, because it feeds AutoCount's
UDF_BALANCE and a licensed ledger is not where a credit belongs); migration 0301
un-floors the view's balance_centi_live so the list agrees with the detail page.
Negative renders red on every SO balance surface, and the print flips BALANCE
DUE to CREDIT BALANCE. Both signed rules refuse to go negative on a ZERO total —
that is every AutoCount import, 2,687 of prod's 2,824 live orders, so a bare
total - paid would have reddened 2,121 legacy orders for RM 9.26m nobody
over-collected.

**Ref.** fix/allow-overcollection-negative-balance, 2026-08-16.
