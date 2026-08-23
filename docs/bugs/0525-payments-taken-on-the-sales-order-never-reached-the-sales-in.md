## Payments taken on the Sales Order never reached the Sales Invoice [high]

**Symptom.** The owner, 2026-08-23:「payment record怎么没带去invoice那边呢」. One
chain, from his production screenshots: Sales Order `HC-SO-2608-006` shows one
cash payment of MYR 2,000 taken on 23/08/2026 — Deposit Paid 2,000, Balance
2,400. The Sales Invoice raised off that chain, `HC-SI-2608-004`, shows
**"No payments recorded yet"** and an outstanding of the **full MYR 4,400**. The
office was being told to chase money the customer had already handed over.

**Root cause (traced).** Two payment ledgers with no link between them, and
nothing anywhere that applies one to the other:

- `scm.mfg_sales_order_payments`, keyed by `so_doc_no`
- `scm.sales_invoice_payments`, keyed by `sales_invoice_id`

`recomputePaid` in `backend/src/scm/routes/sales-invoices.ts` derived the whole
invoice status from the second table alone, and the detail screen derived
Outstanding from `sales_invoices.paid_sen`, which that same function writes. The
word "deposit" appeared in the entire sales-invoice router exactly twice, both
inside one comment stating the shape of the problem without doing anything about
it: *"a deposit is taken on the ORDER, not on the invoice"*.

**Fix.** The invoice now READS THROUGH to the order it names in its own
`so_doc_no`; no payment row is copied. Copying was rejected on evidence, not
taste: both ledgers already post to the general ledger through the same rule —
`postSoPayment` books SOPAY and `postSiPayment` books SIPAY, and both call
`customerPaymentLines` (`backend/src/acc/rules.ts`), which is Dr cash/bank/transit
and Cr AR. A copied row would debit cash twice and relieve the same receivable
twice, and `acc/daily-close.ts`'s `systemTakings` sums BOTH tables for one day's
cash-up, so the drawer count would have come up short by the whole deposit.

New module `backend/src/scm/lib/si-order-deposit.ts` holds the allocation, and
`recomputePaid` moved into it so the ORDER-side payment writer can run the same
roll (a deposit recorded after the invoice was raised would otherwise leave the
invoice LIST stale). Where one order produced several invoices the deposit is
consumed **earliest invoice first, then spilled to the next** — the owner's own
rule, same day:「先扣第一张，扣完再溢到下一张」. The ordering key is
`invoice_date` then `invoice_number`, which is a total order; `created_at` was
rejected because two invoices converted in one action can tie on it.
CANCELLED and DRAFT invoices absorb nothing.

`paid_sen` deliberately still means what it always meant — receipts banked
against THIS invoice — because the GL posting, `scm.v_si_outstanding` and the
AutoCount write-back all read it. The order's deposit is added to the STATUS
decision and shown as its own labelled line on screen.

Pinned by `backend/src/scm/lib/si-order-deposit.test.ts` (19 tests), which was
proved RED on the unfixed behaviour: ten separate guards were deleted one at a
time and every one turned the suite red, including the bug itself (dropping the
deposit term from the status ladder fails 3 tests). The money invariant — the
slices sum to `min(order collected, what the invoices can absorb)` and never
exceed either side — is asserted over 400 generated cases.

**Ref.** `feat/the-invoice-knows-what-the-order-collected`, 2026-08-23.
