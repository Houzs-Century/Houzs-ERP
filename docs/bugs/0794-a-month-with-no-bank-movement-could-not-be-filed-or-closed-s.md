## A month with no bank movement could not be filed or closed, so the lock chain broke on March [medium]

<!-- area: Accounting + GL -->

**Symptom.** 2990's Hong Leong account opened in February 2026 with RM 3,000.00
and nothing moved in March. Hong Leong's March export
(`acs_…_31032026.csv`) is the account header, the column header, and one row —
*"Balance from previous statement 3000.00"*. Uploading it: *"The HLB 310-0020
statement has a heading row but no transactions under it — 1 row(s) were read
and none carried both a date and an amount."* Nothing was filed, March never
appeared under **By month**, and the month could not be closed: `mayLockMonth`
refused any month with zero movements as `empty_month`. The owner
(2026-09-10): 「我应该每一个月都要做 bank reconciliation 不是？没有 transaction
那么你就让我锁起来还是怎样，不应该是这样吗？」— and he is right. A quiet month
is still reconciled (bank RM 3,000.00 = books RM 3,000.00) and closed; a chain
of closed months with a hole at March is not a chain.

**Root cause (traced).** Two guards written against a different danger.
`parseBankStatement` (`backend/src/acc/bank-parse.ts`) refused any file with
no readable movement so that a heading row with an unreadable table under it
could never be reported as a clean empty statement — right for that file,
wrong for a file that prints its balance and simply has no movement.
`mayLockMonth` (`backend/src/acc/bank-lock.ts`) refused `lineCount === 0` so
an empty month could not be used to make a claim — but it measured the wrong
thing: what a close needs is a STATEMENT, not a movement. And the month
routes (`accounting-bank-months.ts`) found a month's files through the LINES
that landed in it, so even a filed empty statement would have fed no month.

**Fix.** *The parser.* A file with a balance row and no movement is a
statement of that balance: `lines: []`, opening = closing = the balance it
printed, in/out 0, and its period is the calendar month the operator named in
the **Year and month** box — the file itself carries no date, so without that
box it is refused with what to do (*"carries no transactions — it opens and
closes at RM 3,000.00. Choose the year and month it is for and upload it
again"*). A file with neither movement nor balance still proves nothing and is
still refused as before.

*The months.* `feedersOf` in `accounting-bank-months.ts`: a month's files are
the ones a line came from **plus an empty statement (`line_count = 0`) whose
period lies wholly inside the month** — used by the month list, the month
detail and `loadMonthForLock`, so the three cannot disagree. The list buckets
such a statement under its month with 0 movements; `assembleMonth` needs no
change (the file lies inside the month by construction, so it speaks for both
balances and the month is complete).

*The lock.* `LockRequest` gains `statementCount`; `empty_month` is now "no
statement filed" (*"one with no transactions in it still counts, filed under
the month it is for"*), and a quiet month with a statement goes through the
same doubts as any other — difference 0 and complete closes with no ceremony;
a file filed under the wrong month is caught by its balance against the
ledger and wants a reason. The upload route writes no line rows for it.

*The screen.* The sentence under **Year and month** says it also files a
statement with no transactions; the upload result reads *"No transactions in
this statement — filed for 2026-03 at RM 3,000.00 throughout. The month can be
reconciled and closed under By month."* rather than "0 movement(s)".

Pinned by `bank-parse.test.ts` (filed under the named month at its balance;
asks for the month when none was given; a file with no balance still
refused), `bank-lock.test.ts` (no statement → `empty_month`; a statement and
no movement closes; a quiet month that does not reconcile wants a reason),
`bank-month.test.ts` (an empty statement makes its month complete),
`backend/tests/bankRoutes.test.ts` (the HLB account; upload refused without a
month and filed with one; the month list shows it complete; it locks;
filed under the wrong month the close wants a reason; a month with no
statement cannot close — the month and lock routes' first contract test) and
`BankStatementTab.test.tsx`. Proved RED on the unfixed tree (11 failed), then
GREEN.

**Ref.** acc/bank-empty-month, 2026-09-10.
