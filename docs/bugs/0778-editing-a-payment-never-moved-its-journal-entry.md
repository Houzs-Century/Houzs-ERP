## Editing a payment never moved its journal entry [high]

<!-- area: Accounting + GL -->

**Symptom.** Correct a customer payment's amount and the books do not follow.
The payment row says RM 1,991.00, its journal entry still says RM 1,990.00,
and nothing anywhere refuses, warns or logs. Step 1 (docs/bugs/0774) made the
divergence visible on Self-check; this is the same defect, from the other end.

**Root cause (traced).** `mfgSalesOrders.patch('/:docNo/payments/:id')` ends
with three calls — `recordSoAudit`, `queueAcSoEdit`, `recomputeSiPaidForOrder`
— and none of them touch `journal_entries`. The sibling DELETE has reached the
ledger since 2026-08-16 (`afterSoPaymentRemoved` → `reverseSoPayment`); the
edit path was simply never given the same hook. It has been reachable the whole
time: a payment is editable on the day it was keyed, which is precisely the day
most corrections happen. The measured count is 0 amount disagreements on
production only because that window is one day wide, and the owner has now
confirmed with management that Finance will hold the correction right — which
opens it.

**Fix.** `backend/src/acc/payment-repost.ts`. Two decisions live there, both
deliberate:

*Which edits move the books.* Four fields, and only four: `amount_sen`,
`paid_at`, `method` (it picks the debit account) and `merchant_provider` (it
picks WHICH transit account a card payment lands in). An approval code, an
account sheet, a collector, an installment term, an online sub-type — none of
them change a line, and re-posting for one of those would churn the ledger and
spend a JE number rewriting the same entry. `ledgerBearingChange` answers which
of the four actually moved; an acquirer set on a method that resolves none is
not a change, and a blank provider and an absent one are the same acquirer.

*Where the correcting contra is dated.* On the **original entry's date**, not
today. An edit corrects a mistake made that day, so the wrong entry and its
reversal must net to zero in the month they were made. Dated today instead, a
corrected RM 1,990 would leave that money standing in one month's bank column
and a matching negative in another — exactly what the bank reconciliation this
work exists to serve cannot absorb. DELETE is deliberately left alone: removing
a payment is an event that happens today, and its contra still dates today.

The route calls `repostSoPaymentBestEffort` (beside `bookSoPaymentBestEffort`
in `scm/lib/so-payment-row.ts`) on the same contract as every other hook on
that path: the operator's edit has already committed and a ledger refusal may
not turn it into a 500 they would retry. A refusal is carried up and logged
rather than swallowed — it leaves the payment with no active entry, which is
the Self-check unbooked card's finding and the backfill's to heal.

Proved RED on the unfixed tree twice over. `backend/src/acc/payment-repost.test.ts`
(16 cases) failed to resolve its import before the module existed, and then
exercised the real poster through the fake PostgREST client — a corrected
amount, date, method and acquirer each land on the right account, re-posting
three times converges on ONE active entry, a never-booked payment is simply
booked, an `imported` row is left where AutoCount put it, and a re-post the
gate refuses comes back as a refusal with no active entry left behind.
`backend/tests/soPaymentEditReposts.test.ts` (6 cases) was proved RED against
the unfixed route file itself (3 of 6 failed): it pins that the PATCH handler
calls the re-post, that it is handed BOTH sides and all four ledger fields, and
that DELETE still goes through its own hook.

A trap worth naming: the live-entry read filters `reversed` in JavaScript, not
in the query. The column defaults to FALSE in Postgres but is simply ABSENT on
a freshly inserted row in the fake client, so `.eq('reversed', false)` matched
nothing and the entire reversal was silently skipped — the first run of these
tests showed a "re-posted" result over an untouched entry. `reverseJournal` and
`unbookedPayments` already read it the same way, for the same reason.

**Not fixed here, on purpose.** Sales-invoice payments have a DELETE that
reverses but no edit route at all, so there is no SI edit to correct. And
Finance still cannot edit an old payment: that is step 3, gated on **"editable
until the payment has been RECONCILED"** rather than by time —
`so-field-policy.ts` already reserves the one place that condition lands, and
its refusal message still promises a path ("ask the office to adjust it") that
does not exist until then.

**Ref.** acc/payment-edit-reposts, 2026-09-10.
