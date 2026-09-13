## A Maybank month could never tally or close, and By month mixed the accounts [medium]

<!-- area: Accounting + GL -->

**Symptom.** Three things on `/scm/bank-recon`, all raised by the owner on
2026-09-13 once 2990's Maybank statements started uploading (docs/bugs/0856):
(1) the By month list put Maybank's and Hong Leong's months in one table —
by month 这里我无法分辨什么也会; (2) matching lived on the file screen and the
lock on the month screen — 我的 matching 在 bank statement，然后 lock 在 by
month？不能做一起？; (3) a Maybank month was always "not covered end to end":
the Account Activity Report prints movements and no balance, so the month had
no opening, no closing, nothing to tally against, and "Close this month" could
never come on.

**Root cause (traced).** (3) is the design of `backend/src/acc/bank-month.ts`
rule 2 meeting a file it was not written for: a balance is taken only off a
file that prints one, which is right for Hong Leong's export and leaves a
Maybank month with `statementOpeningSen`/`statementClosingSen` null for ever.
`reconcileBankStatement` then has no bank figure, `unexplainedSen` is null,
and `mayLockMonth` refuses with `no_closing`. (1) and (2) are layout: the list
was one table keyed account|month, and the auto-match door
(`POST /bank/statements/:id/auto-match`, docs/bugs/0814) was wired only into
the file screen.

**Fix.** Owner: 做 做 做.

- **The typed month-end figure.** New table `scm.acc_bank_month_balances`
  (migration `backend/src/db/migrations-pg/20260913T1000_acc_bank_month_balances.sql`,
  one row per company × account × month: `closing_sen`, `note`, `typed_by`,
  `typed_at`). `assembleMonth` takes a fourth argument, the typed figures, and
  applies **rule 4**: a figure a file PRINTS always wins; where none does, this
  month's typed closing is the closing and the PREVIOUS month's typed closing
  is the opening (a month opens where the last one closed). A typed figure is
  checked the way the chain is — opening plus the month's non-ignored
  movements must reach the closing — and a shortfall is a gap sentence with
  the amount ("RM 123.45 is unaccounted for: a day is missing from the files,
  or a typed figure is wrong") that keeps the month not whole. `BalanceSource`
  carries `typed: { month, by, at, note }` so the screen and the report
  (`bank-reconciliation-pdf.ts`) name who typed it. Door:
  `POST /accounting/bank/months/:accountCode/:month/closing`
  `{ closingSen | null, note? }` in `accounting-bank-months.ts` — refuses a
  non-integer, an account with no statement config, a closed month, and a
  month whose NEXT month is closed (that month opens at this figure). The
  month view offers the box only where no file prints the figure, with a
  second box for the previous month's closing when the opening is missing.
- **One account at a time.** `frontend/src/pages/scm-v2/BankAccountTabs.tsx`
  — a `role="tablist"` shared by the By month list and the Bank statement
  file list, labelled `MBB · 310-0010` off the bank setup; the picked account
  lives above the list so coming back from a month lands on it.
- **The month says what is left and runs the rule.** `BankMonthTab.tsx` gets
  "N still to decide" / "Nothing left to decide" under the header and "Match
  the obvious ones now", which runs the existing per-statement door over every
  file that fed the month, sums the answer, and names any file the server
  refused while the others still run.

Pinned by `backend/src/acc/bank-month.test.ts` (rule 4, the shortfall, a
printed figure winning, a figure for the wrong month ignored),
`backend/tests/bankRoutes.test.ts` (the door, the month and list reading the
typed figures, the lock refusing a shortfall, the closed-month refusals),
`frontend/src/pages/scm-v2/BankMonthTab.test.tsx`,
`BankStatementTab.test.tsx` and `bank-reconciliation-pdf.test.ts`.

**Ref.** acc/bank-month-tabs-balances, 2026-09-13.
