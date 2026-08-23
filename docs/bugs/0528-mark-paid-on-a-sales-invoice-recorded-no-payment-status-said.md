## Mark paid on a Sales Invoice recorded no payment — status said PAID, paid_sen stayed 0 [high]

**Symptom.** Pressing **Mark paid** on a Sales Invoice marked the document
settled and banked nothing. The invoice then held two columns of its own that
contradicted each other — `status = 'PAID'` beside `paid_sen = 0` — so the
document read as collected while the payments ledger, the AR aging view and the
day's cash-up all still showed the money as never received. And it did not even
hold: the next time anything touched that invoice's money the status flipped
back on its own, so an invoice somebody had "marked paid" re-appeared in the
chase with no record of who marked it or why it changed.

**Root cause (traced).** `doMarkPaid` in
`frontend/src/pages/scm-v2/SalesInvoiceDetailV2.tsx` called
`useUpdateSalesInvoiceStatus` → `PATCH /sales-invoices/:id/status` with
`{ status: 'PAID' }`. That handler
(`patchSalesInvoiceStatusHandler`, `backend/src/scm/routes/sales-invoices.ts`)
writes the status column and `paid_at` and nothing else: it never touches
`scm.sales_invoice_payments` and never touches `paid_sen`.

The status of this document is not a field anybody is supposed to type. It is
DERIVED: `recomputeSiPaid` (`backend/src/scm/lib/si-order-deposit.ts`) sums the
payments ledger and writes `paid >= total → PAID`, `paid > 0 →
PARTIALLY_PAID`, else `SENT`. It runs on every payment insert, edit and delete,
and since #2681 also whenever the source order's deposit changes. So the
hand-written value was always going to be overwritten by the derivation — the
button was writing into a column owned by a rollup. The module guide already
recorded the intended design and the code contradicted it:
`docs/modules/sales-invoice.md` §3 lists PAID as set by "`recomputePaid` only —
**automatic**".

Two payment endpoints that DO record the money were sitting beside it unused:
`POST /:id/payments` (full body, method from the `PAYMENT_METHOD_CODES` enum)
and the legacy `PATCH /:id/payment` (amount only, method hard-coded `cash`).

**A second fault, found while fixing the first.** The button was only ever
OFFERED when the balance was already zero — `canMarkPaid = !isTerminal &&
!isDraft && outstanding === 0`, unchanged since the screen was written (#311).
So in every situation the button could be pressed there was nothing to collect,
and the only thing it could do was the thing that was wrong. The states that
reach it are a zero-total invoice (`siStatusFor` never returns PAID when
`total_sen` is 0, so the button shows there forever) and an invoice whose
derivation has not caught up. Neither wanted a hand-written status; both wanted
either a real receipt or nothing.

**Fix.** Mark paid records a real receipt and writes NO status.

It seeds the same payments editor that **Record payment** opens, with one row
pre-filled at the invoice's outstanding balance, and commits on Save through
`POST /:id/payments` — the one path a manually-entered payment already takes, so
`recomputeSiPaid` rolls the status, the GL posting happens once, and the
overpay/credit reconciliation runs exactly as it does for every other receipt.

The amount is the outstanding balance **net of the source order's deposit**,
which is the same `outstandingOf(header, items, depositSen)` the Outstanding hero
prints. On the owner's own chain — a MYR 4,400 invoice whose order already
collected MYR 2,000 — it records **2,400**. Recording 4,400 would have debited
cash twice for the deposit: the order's payment is read THROUGH, never copied,
because both ledgers post Dr cash/bank and Cr AR through `customerPaymentLines`
and `acc/daily-close.ts` sums both tables for one day's takings
(`docs/bugs/0525-payments-taken-on-the-sales-order-never-reached-the-sales-in.md`).

The **method is the operator's**, never guessed. There is no honest default: a
silent `cash` lands in the daily cash-up and leaves the drawer short by the
amount. So the button stops at the editor with the row visible and Save is the
commit point.

New module `frontend/src/pages/scm-v2/markPaidPlan.ts` holds the four refusals,
and each one refuses rather than recording money that did not arrive:

| situation | why it refuses |
|---|---|
| nothing outstanding | a zero-value receipt is not a payment; the button is hidden |
| the order's deposit could not be read (`orderDepositUnavailable`) | the outstanding on screen falls back to the FULL total, so it is too high by the whole deposit — recording it would book the deposit a second time |
| CANCELLED | the payment routes answer `not_payable`; an action that can only 409 is not offered |
| DRAFT | same, and a draft has posted no revenue yet |

Pinned by `frontend/src/pages/scm-v2/markPaidRecordsTheMoney.test.tsx` (8 tests),
which mounts the real page and asserts what the operator gets. Proved RED on the
unfixed behaviour by deleting each guard in turn — six deletions, every one red:
restoring the status write (4 red), recording the gross total instead of the
net outstanding (3 red), restoring `outstanding === 0` visibility (5 red), and
dropping each of the three refusals (1-2 red each).

**Still open — the LIST carries the same button and it was NOT fixed here.**
`frontend/src/pages/scm-v2/SalesInvoicesListV2.tsx:1041` has its own `doMarkPaid`
sending `{ status: "paid" }` to the same endpoint, offered on the same
`outstanding === 0` rule. It is left alone deliberately, not overlooked: that
screen's `outstandingOf` is `total − paid` with **no deposit term** (`:215-216`),
so giving it the same fix today would record the GROSS balance and book the
customer's order deposit a second time — the one outcome this change exists to
prevent. It needs the deposit-adjusted outstanding on the list first (in flight
on a sibling branch), or a navigation into the detail screen's editor, where the
figure is already correct. Owner's call, raised as an open question on the PR.

**Ref.** `fix/mark-paid-records-the-money`, 2026-08-23.
