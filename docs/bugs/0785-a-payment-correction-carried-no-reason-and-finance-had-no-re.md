## A payment correction carried no reason, and Finance had no report of them [medium]

<!-- area: Accounting + GL -->

**Symptom.** With bug 0780 shipped, Finance could correct a customer payment
after the day it was keyed — but the correction said nothing about WHY, and the
only trace was one line in that order's audit history. Owner, 2026-09-10:
「可以有一个 report 在我 finance 模块这里关于我更改的吗？要写 reason 错什么」.
Then, asked whether a same-day fix by sales should carry a reason too:
「这个不需要，可以规定靠权限改的来决定」.

**Root cause (traced).** Neither payment route accepted a reason:
`paymentPatchSchema` had no such field and the DELETE read only `version` off
the query. `paymentRowMutable` answered *whether* a row could change but not
*why* — so no caller could tell a same-day fix (fluid by the owner's 2026-07-19
ruling, no reason owed) from a correction the amend right had opened. And the
audit rows it did write were indistinguishable from any other
`UPDATE_PAYMENT`: same `source = 'web'`, no note, no trace of what the ledger
did. There was nothing for a report to read.

**Fix.** No new table. Three pieces, one for each missing fact.

*The predicate says why.* `PaymentRowMutability` gains `via: 'draft' |
'same_day' | 'amend' | null` in both copies of `so-field-policy.ts`
(`check-shared-mirrors.mjs` still reports `paymentRowMutable` identical). Only
the predicate knows which rule it just allowed, so only it can say.

*The routes take a reason, and only ask for it on the amend right.* The PATCH
body gains `reason` (trimmed, ≤500); the DELETE reads `?reason=` beside
`?version=`. When `via === 'amend'` and no reason came, both refuse with
`reason_required` in a plain sentence. The audit row for such a correction
carries `source = 'amend'`, the reason in `note`, and one extra field change
`ledger: reversedJeNo → jeNo` — for which `repostSoPaymentEdit` now returns the
contra's number, `afterSoPaymentRemoved` returns its reversal, and the PATCH
re-posts BEFORE it audits, so the row can carry both numbers. A same-day fix
writes the same audit row it always did.

*The report is a filtered read of that log.* `GET /accounting/payment-corrections?month=`
(`scm/routes/accounting-payment-corrections.ts`) reads `mfg_so_audit_log` for
`source = 'amend'` and the two payment actions, this company, this month;
`acc/payment-corrections.ts` shapes it (newest first, the ledger pair pulled
out of the changes, the summary added up). The Accounting page gains a
**Corrections** tab — month, person filter, three cards, the table, Print — and
`payment-corrections-pdf.ts` builds the document from `correctionsDocument`,
the same pure-then-draw shape as the bank reconciliation statement.

*The screens ask before they write.* `ConfirmDialog` gains an optional text
input and a `usePrompt` beside `useConfirm` (same provider, same dialog); a
required input cannot be confirmed blank, so a non-null answer is never empty.
Desktop `PaymentsTable` and mobile `RecordedPayments` ask when `via === 'amend'`
— the mobile sheet is told by its parent through `reasonRequired`, because the
permission and the draft flag live with the list — and abandon the write when
the ask is dismissed.

Proved RED on the unfixed tree: `soPaymentAmendRight.test.ts`'s four `via`
cases failed on the three-field result; `payment-corrections.test.ts` (13
cases) failed to resolve its import; `paymentCorrectionsRoute.test.ts` (5
cases) returned an empty report — which uncovered a fake-client trap below.
`tests/soPaymentAmendRoutes.test.ts` gained five cases pinning both routes:
gate on `via === 'amend'`, refuse with `REASON_REQUIRED`, audit with
`AMEND_SOURCE` and the note, carry `ledgerFieldChange`, and re-post BEFORE the
audit. Frontend: `ConfirmDialog.test.tsx` (3), `payment-corrections-pdf.test.ts`
(9), `PaymentCorrectionsTab.test.tsx` (4), and three more source cases in
`soPaymentAmendClients.test.ts` — both screens read `.via`, ask through
`usePrompt` with `required: true`, send `{ reason }`, and stop on
`reason === null`.

**A trap worth naming.** `fake-postgrest`'s `lt` compared numerically with a
`?? 0` fold, unlike its `gte`/`lte`, which compare by the column's type and
let NULL match nothing. So the only correct shape for a timestamptz month
window — `gte(first) + lt(next-first)` — returned an empty report against the
fake while the real database returned the rows. `lt` now matches its siblings.

**Not fixed here, on purpose.** Same-day corrections by whoever keyed the
payment carry no reason and are not on this report — the owner's ruling. The
order's own audit history still shows them.

**Ref.** acc/payment-corrections-report, 2026-09-10.
