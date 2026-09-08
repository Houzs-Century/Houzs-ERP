## A header whose children were all retired was pickable and passed the typing-time check, then the GL gate refused it at approve [medium]

<!-- area: Accounting + GL -->

**Symptom.** The owner, 2026-09-08, on 2990-HPV-2607-003 (SHOWROOM RENTAL
JUL'26, RM 45,000, line account 900-R006 RENTAL- SHOWROOM): 900-r006 是父
account，之前我没加子 account，但他出现在我选 account 这里. In prod 900-R006
has had three retired showrooms under it since the chart seed (900-R007/R008/
R009, is_active false) and gained a live one today (900-R048 RENTAL OF
SHOWROOM - 2990S). The voucher was raised and Checked on 2026-09-07 with the
header on its line; Approve would have been refused by the GL gate ("account
900-R006 is a parent header — post to its children").

**Root cause (traced).** 父户不记账 was three doors with two rules. The GL gate
(`validateChart`, backend/src/acc/engine.ts) builds its parent set from EVERY
account's `parent_code`, retired children included. `requireLeafAccount`
(backend/src/scm/routes/accounting-chart.ts) looked for children with
`.eq('is_active', true)` only — pinned by a test that said a header whose
children were all retired "books again" — and every picker page handed
AccountSelect the ACTIVE accounts alone, so the picker's own parent set could
not see a retired child either. A header with only retired children was
therefore a leaf at typing time and in the picker, and a parent at approve.
Seen in prod by read-only SQL: company 2 has exactly two active headers whose
children are all retired (900-R006 until today, 360-0000 PREPAYMENT & ADVANCE),
and no account with children carries a journal line.

**Fix.** One rule at all three doors, the gate's: a header is any account with
a sub-account, retired ones included. `requireLeafAccount` drops the
`is_active` filter (its message says retired ones count); the screens take
their pickable list from `postableAccounts` / `leafAccounts`
(frontend/src/vendor/scm/lib/accounting-queries.ts), fed the WHOLE chart, on
PaymentVoucherNew, PaymentVoucherDetail, ApInvoices, OtherDebtors, Receipts and
the manual journal on Accounting.tsx. Pinned by
`backend/tests/accountingChart.test.ts` "a header whose children are all
RETIRED stays a header" (RED on the unfixed tree: the door answered null) and
`AccountSelect.test.tsx` "a retired child still makes its parent a header"
(RED: postableAccounts did not exist; the active-only list offered 900-R006).
The owner's voucher: Reject → edit the line to 900-R048 → Check → Approve.

**Ref.** fix/parent-account-every-door, 2026-09-08.
