## A cancelled order's card payment was still offered to the merchant report [medium]

<!-- area: Accounting + GL -->

**Symptom.** Three of 2990's card payments sit on CANCELLED orders
(SO-2607-010 RM 1,723, SO-2607-024 RM 3,365, SO-2608-028 RM 1,433 — the
last a duplicate of SO-2607-019's). Merchant reconciliation kept offering
them: as candidates on every statement line of the right amount, on the
"card payments no merchant report has reported yet" table, and through Find
the sale — so a statement line could be confirmed against money the sale
behind it no longer exists for, and the watch list counted them as money the
acquirer still owed. Asked how a cancelled order's payment should show
(bug 0821 had deferred it: 要再决定), the owner (2026-09-12): cancel SO 就
cancel 不显示.

**Root cause.** `loadPaymentCandidates` and `findPaymentsForRow` read the
order only for its customer's name; the order's status never entered the
question of whether its money is a sale to reconcile.

**Fix.** Both readers in `backend/src/acc/settlement.ts` take the status on
the same read as the name and leave out every payment whose order is
CANCELLED — offered on no line, on neither watch list (the page's "no report
yet" table reads the same loader), not findable. The money is not a sale to
reconcile: it waits to be converted to a new order (the convert-payment
design, decided and not yet built) or refunded, and only then is it a
candidate again. A link already confirmed against such a payment is
untouched — the link is the ledger's.

Pinned by `backend/src/acc/settlement.test.ts` (the loader leaves a cancelled
order's payment out even when the statement carries its reference) and
`backend/tests/settlementRoutes.test.ts` (off the watch list; not found by
Find the sale while the same customer's live order is).

**Ref.** acc/recon-hide-cancelled, 2026-09-12.
