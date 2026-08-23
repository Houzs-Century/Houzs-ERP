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

Pinned by `frontend/src/pages/scm-v2/markPaidRecordsTheMoney.test.tsx` (15 tests),
which mounts the real page and asserts what the operator gets. Proved RED on the
unfixed behaviour by deleting each guard in turn — NINE deletions, every one
red: restoring the status write (4 red), recording the gross total instead of the
net outstanding (3 red), restoring `outstanding === 0` visibility (5 red),
dropping each of the three refusals (1-2 red each), removing the intent consumer
so the link goes dead again (2 red), making `pay=balance` fall through to a plain
open (1 red), and leaving the intent in the URL after acting (1 red).

That last one was NOT red at first. The assertion called `stripSiPaymentIntent`
directly, so deleting the strip from the effect left it green — a test of the
helper the effect was SUPPOSED to call, not of what the effect did. It now reads
the router's own URL through a probe component, and it bites.

**The LIST carried the same button, and it is fixed here too.**
`frontend/src/pages/scm-v2/SalesInvoicesListV2.tsx` had its own `doMarkPaid`
sending `{ status: "paid" }` to the same endpoint. It could not simply copy the
detail page's fix: a list row carries only `so_deposit_applied_sen`, and
`siDepositAppliedSen` reads absent-or-null as **0**, so "the order collected
nothing" and "we could not read the order" are the same value there. That is the
right default for a figure being DISPLAYED — over-stating what is owed sends
someone to check — and the wrong one for a figure about to be booked as cash,
where it would record the customer's deposit a second time. Only
`GET /sales-invoices/:id` answers the difference, with `orderDepositUnavailable`.

So the list DELEGATES: Mark paid now opens the detail screen's payment editor
with the balance seeded, and the amount is computed on the screen that can tell
the two apart. New module `frontend/src/pages/scm-v2/siPaymentIntent.ts` owns
that URL contract.

**A second, separate defect found while wiring it: the list's Record payment did
nothing at all.** It navigated to `?tab=payments&record=1`, and nothing in the
app has ever read `tab` or `record` on a sales invoice — `SalesInvoiceDetailV2`
calls `useSearchParams()` and never calls `.get()` (verified on the merged tree:
`grep -n "\bparams\b"` returns the declaration and nothing else). Pressing it
opened the invoice and left the operator looking at a page that had not changed
— the "the button does nothing" shape CLAUDE.md names as the worst kind. It is
fixed by the same module, because the mechanism was one line away and leaving one
of two adjacent payment buttons dead would have been the N-1 failure this repo
keeps paying for. That is why the param is a shared module and not a string in
two files: the writer and the reader are now testable together, which is exactly
what the old one lacked. The Purchase Invoice pages use the same dead pattern
(`PurchaseInvoiceDetailV2.tsx`, `PurchaseInvoicesListV2.tsx`) and are NOT touched
here — different module, and no evidence gathered about them.

**Ref.** `fix/mark-paid-records-the-money`, 2026-08-23.
