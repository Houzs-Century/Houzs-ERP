## A bank charge deducted from a payout had nowhere to go, so the advice stayed red [medium]

<!-- area: Accounting + GL -->

**Symptom.** Public Bank's advice `2990HOMESB_IBG_20260608.pdf` pays three
trading days. For 2026-06-06 it says RM 3,024.18; the merchant report for that
day nets RM 3,348.18. The Payment advice screen said *"differs by RM 324.00"*
and stopped. The owner checked with the bank: the RM 324.00 is a card-terminal
application fee the bank deducted from the payout. 「我该如何做」— and there was
nothing to do. A receipt books only what the bank credited (Dr bank / Cr
transit for the credit), so booking RM 3,024.18 would have left PBB's transit
account RM 324.00 short for ever and the advice red for ever; a manual journal
would have fixed the ledger and left the screen red.

**Root cause (traced).** `statusOfPayout` (acc/payout-advice.ts) compares the
report's net with the advice's net and nothing else — *"a difference is the
finding"* was the design, and it was right until a difference turned out to
be a fact the bank had already acted on. No table held a deduction, no journal
could express one, and `postBatchReceipt` counted only credits toward what a
statement had been paid.

**Fix.** The charge belongs to the ADVICE DAY it was deducted from, so it lives
on that row — migration `20260910T1200` adds `charge_sen`, `charge_account_code`,
`charge_note`, `charge_je_no/id`, `charge_by`, `charged_at` to
`scm.acc_settlement_payout_batches`, with a check that the amount and the
account move together. `statusOfPayout` reads them: a day agrees when
**report net = advice net + charge**, and carries the charge so the screen can
show where it went; a charge covering only part of the gap leaves the rest a
finding.

`acc/payout-charge.ts` books it: `postPayoutCharge` refuses without a note,
refuses a day with no report (the difference is not known), a day that already
agrees, a second charge on a charged day (undo first), an amount above the
difference (that is a mismatch, not a deduction), and any account that is not
an ACTIVE EXPENSE LEAF of THIS company — the same four refusals the merchant
fee account answers with, now shared as `checkExpenseLeaf`. The account is
**Finance's choice** (owner: 可以让我点了后选这笔进什么户口吗), starting on the
acquirer's fee account. The journal is Dr the chosen account / Cr the
acquirer's transit, **dated the settlement day** — the deduction happened
then, not when the button was pressed — source `SETTLECHARGE` keyed on the day
row. `undoPayoutCharge` reverses through the engine (contra on the same day)
and clears the row. `loadBatchReceipts` now returns what the bank deducted
beside what it credited, and `postBatchReceipt` counts both toward the
statement, so the credit that arrives after a RM 324 fee is the whole of what
was owed and the statement reads fully received.

Routes `POST` / `DELETE /accounting/settlement/payouts/:id/days/:settledOn/charge`
answer each refusal as a sentence; the list carries the accounts the dialog may
offer (`expenseLeafAccounts`, shared with the Setup page) and each acquirer's
fee account. On the Payment advice tab a day the bank paid *less* for offers
**Bank deducted a charge** → amount (the difference), account (a select), note
(required) → **Book charge**; the day then reads *"agrees · bank charge
RM 324.00 → 900-T009 (…)"* with **Undo**. A day the bank paid *more* for is
not offered the button.

Proved RED on the unfixed tree: `acc/payout-charge.test.ts` (16 cases) failed
to resolve its import and three new `statusOfPayout` cases failed before the
charge fields existed; `acc/settlement-receipt-charge.test.ts` (4 cases) found
RM 324.00 left outstanding after the credit until `postBatchReceipt` counted the
charge. `scm/routes/payoutChargeRoute.test.ts` (5 cases) drives the real
handlers, and `PayoutAdviceTab.test.tsx` gained three cases for the ask, the
charged day, and the day that must not be offered one.

**Verified against:** staging `minnapsemfzjmtvnnvdd`, `apply_migration`
`acc_settlement_payout_day_charge_20260910T1200` — success; the seven
`charge*` columns read back from `information_schema.columns` with the
expected types and the `0` default.

**Not fixed here, on purpose.** The one PBB advice already uploaded
(2026-06-08) is not touched by this PR: the owner books its RM 324.00 himself
from the screen, with the reason and the account he chooses.

**Ref.** acc/payout-bank-charge, 2026-09-10.
