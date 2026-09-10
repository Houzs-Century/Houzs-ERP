## An edited payment leaves its journal entry behind and nothing says so [high]

<!-- area: Accounting + GL -->

**Symptom.** Sales keyed a customer payment as RM 1,990.00 when the customer
had paid RM 1,991.00, and the bank reconciliation could not match the line
(2026-09-09, report 076206). Asked what happens if sales simply corrects the
figure, the honest answer was: the payment row changes, the journal entry does
not, and no screen anywhere reports the difference. The owner then confirmed
with management that the power to correct a mis-keyed payment moves to Finance
— which is exactly the change that makes this reachable in volume.

**Root cause (traced).** `PATCH /:docNo/payments/:id` updates the payment row,
recomputes the invoice's paid amount, queues an AutoCount edit, and stops — it
never touches `journal_entries`. (DELETE is different: `afterSoPaymentRemoved`
reverses the SOPAY entry.) The only thing keeping the two in step today is an
accident: `paymentRowMutable` in `backend/src/scm/shared/so-field-policy.ts`
allows a change only on the day the payment was keyed, so almost nothing lives
long enough to drift. Measured on production 2026-09-10: 0 payments disagreed
with their entry on amount, 3 on date. That zero is the edit window's doing,
not the code's, and opening the window to Finance removes it.

`/control-check` already reported money that never reached the ledger. It had
no answer for money that reached it and then stopped agreeing with it.

**Fix.** This is the first of the three steps the owner agreed, and it is the
one that writes nothing: **detect**. `backend/src/acc/payment-drift.ts` is a
pure comparison of a payment against the ACTIVE entry that claims to explain
it, reporting amount, date and method — the method is recovered from the
narration the poster itself writes (`Payment {method} on {docNo}`), and when
the narration is not that shape no method claim is made rather than a guessed
one. A changed acquirer is deliberately NOT reported: it lives in the entry's
lines, not its header, and the honest limit is stated on the card. Payments
with no active entry are left to the unbooked check, so no payment is shown
twice under two names. `paymentEntryDisagreements` in `acc/payments.ts` does
the reads — both payment tables paged in full, because the date is one of the
things under suspicion and a date window would hide the row it was looking
for. `/control-check` returns it as `paymentDrift`, and the Self-check tab
gains a card that shows both sides of every difference.

Proved RED on the unfixed tree: `backend/src/acc/payment-drift.test.ts` (13
cases) failed to resolve its import before `payment-drift.ts` existed. Route
level: `backend/src/scm/routes/controlCheckPaymentDrift.test.ts` (6 cases)
drives the real route through the fake PostgREST client and pins the four
neighbours the check must not disturb — an `imported` row, a reversed entry,
an entry whose narration is not the poster's, and a payment that never booked.
Card: `frontend/src/pages/scm-v2/PaymentDriftCard.test.tsx` (8 cases) pins that
a clean answer over zero entries reads "nothing to compare", never "all of
them" — and that the card offers no fix button, because the fix does not exist
yet.

**Not fixed here, on purpose.** The entry is still not corrected when a payment
is edited (step 2: make the edit reverse and re-post), and Finance still cannot
edit an old payment at all (step 3, gated on "editable until the payment has
been RECONCILED" rather than by time). Granting step 3 before step 2 would let
the count this card measures climb on books that have already been reconciled.

**Ref.** acc/payment-entry-drift, 2026-09-10.
