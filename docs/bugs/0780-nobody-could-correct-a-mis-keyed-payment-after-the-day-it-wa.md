## Nobody could correct a mis-keyed payment after the day it was recorded [high]

<!-- area: Accounting + GL -->

**Symptom.** Sales keyed a customer payment as RM 1,990.00 when RM 1,991.00 had
been paid, and the bank reconciliation could not match it (2026-09-09, report
076206). By the time Finance found it the next day, nobody in the company could
change the figure — not Finance, not an admin, not the owner. The refusal the
operator saw said *"Record a new payment instead, or ask the office to adjust
it"*, and the second half of that sentence described a path that did not exist:
`paymentRowMutable` was purely time-based, with no permission able to override
it.

**Root cause (traced).** `paymentRowMutable` (`scm/shared/so-field-policy.ts`)
took three arguments — the day the row was keyed, today, and whether the SO is
a draft — and nothing else. That was correct when it was written (owner
2026-07-19: 同天可以任意更改) and its own docblock reserved a place for the rule
the owner deferred: 「如果他已经做完 bank record 并且 knock off 掉了，就不行了」.
Neither the condition nor the permission it implied had been built, so the
one-day window was doing both jobs: it was the only thing keeping edits away
from reconciled books, and it was also the reason a legitimate correction was
impossible.

Owner + management, 2026-09-10: **已经和management 确定了，让权限在finance 这里
更改.**

**Fix.** The third and last step of that decision — steps 1 (see the divergence,
bug 0774) and 2 (the edit re-posts its entry, bug 0778) shipped first and on
purpose, because granting this right before an edit moved the ledger would have
let payments and books drift apart in volume.

`paymentRowMutable` takes a fourth argument, and the ORDER of its rules is the
design:

| | |
|---|---|
| DRAFT | still fluid. The 2026-07-13 exemption, untouched — a draft's payment is not what either later ruling was about. |
| **RECONCILED** | closed to EVERYONE, Finance included, and it beats the same-day window too: a match booked this morning is no less booked for being young. |
| same day | still fluid for whoever keyed it. Unchanged. |
| **may amend** | Finance's new door — `scm.so_payment.amend`, held by nobody except `*` until the owner grants it in Team > Positions. |
| otherwise | the window that has always closed. |

`backend/src/acc/payment-reconciled.ts` answers whether a payment has been
reconciled, and names WHICH of the three genuinely different places closed over
it, because an operator told only "it is reconciled" cannot go and look:
`acc_settlement_matches` claims the payment ROW (the only one that speaks for a
payment that never reached the ledger); `acc_bank_statement_matches` claims its
ACTIVE journal entry by number; `acc_bank_month_locks` closes that entry's
MONEY-leg account for the month — read off the debit line, because the credit
leg is Trade Debtors and a guard that took the wrong line would find no lock and
wave everything through. **Every read fails CLOSED**: "I could not tell" comes
back as a refusal the operator can retry, never as "not reconciled", or the
guard would switch itself off exactly when the database is unhappy.

`paymentMayChange` is the one call both routes make, rather than "load the
reconciliation, then call the predicate" — two steps that must stay in step,
where a route doing only the first half would read as if it had checked. Both
the PATCH and the DELETE go through it; deleting a reconciled payment is worse
than editing one, and the owner's own question (改 还是 删除重新 create) named
both.

The clients pass `mayAmend` and deliberately never pass `reconciled`: a
settlement match lives on the server, so the screens offer the control on the
permission alone and let the endpoint refuse. The refusal sentence is now true
— "ask Finance to adjust it" names a path that exists.

Proved RED on the unfixed tree, three ways.
`backend/src/scm/shared/soPaymentAmendRight.test.ts` (12 cases) failed on the
four-argument predicate before it existed. `backend/src/acc/payment-reconciled.test.ts`
(18 cases) drives the reads through the fake PostgREST client — including one
case per read that withholds a column it selects, so a failing read is proved to
refuse rather than report nothing found. `backend/tests/soPaymentAmendRoutes.test.ts`
(7 cases) was proved RED against the unfixed route file itself (4 of 7 failed):
it pins that both handlers call `paymentMayChange`, that neither calls the bare
predicate any more, that both pass the permission and the resolved company, that
the window still keys off `created_at` and never `paid_at`, and that recording a
payment stays ungated. On the client side,
`frontend/src/vendor/scm/lib/soPaymentAmendClients.test.ts` pins that both
screens pass the fourth argument — dropping it compiles, type-checks, and
silently hides the control from Finance again.

**Not fixed here, on purpose.** The DRAFT exemption is still checked before the
reconciliation, so a draft SO's payment stays editable even if a merchant report
has matched it. That is the 2026-07-13 exemption for an OCR-scanned draft and
this change was not asked to move it; the case is pinned rather than left to
line order, and bug 0774's Self-check card would show it if it ever bit.

**Ref.** acc/payment-edit-finance, 2026-09-10.
