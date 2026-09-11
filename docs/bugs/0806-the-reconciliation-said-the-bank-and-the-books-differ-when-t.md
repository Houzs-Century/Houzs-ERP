## The reconciliation said the bank and the books differ when the only difference was an unpresented payment, and a month could be closed over a gap with a sentence [medium]

<!-- area: Accounting + GL -->

**Symptom.** 2990's April Hong Leong statement, fully matched (2026-09-11):
bank closing RM 938.37, books RM −2,163.31, and one payment — HPV-2604-007,
RM 3,101.68, posted on the 30th, paid by the bank in May — listed under "in
the books, not on this statement". The panel said *"The bank and the books
differ by RM 3,101.68"*, the Difference figure was red, and Close this month
asked *"This month is not clean — why close it anyway?"*. Under it: *"RM
2,883.29 brought forward — explained by 1 entry from earlier months that
cleared on this statement"* — which was six entries (HPV-2604-001…006, 21–28
April, RM 2,883.29 together) and not from earlier months at all; the count was
a hard-coded 1. The owner: 「我觉得他的字眼有点 misleading … 我觉得设计应该是这样:
Closing — the books (−)/+ unreconciled items = Closing bank statement. 每当我一
match, closing 就一直变. 当 closing bank statement amount 无法 tally 就无法 lock」;
asked whether a month should ever close over a gap with a reason: 「应该不会有
银行错吧，毕竟怎样都要 tally bank statement」.

**Root cause (traced).** `reconcileBankStatement` (`backend/src/acc/bank-reconcile.ts`)
answered one question — statement closing minus ledger closing — and called
the month reconciled only when that was zero with nothing outstanding on
either side. An entry the bank has not shown yet is exactly what a bank
reconciliation LISTS; treating it as a difference made every month with an
unpresented payment "differ". The "brought forward" line existed because the
period's opening was compared separately from its movements; its count was a
placeholder (docs/bugs/0802's `BankStatementTab.tsx`), and "earlier months"
assumed a period is a month — April's file, uploaded before the month box
covered a month, had a one-day period. `mayLockMonth` (`acc/bank-lock.ts`)
let any of four doubts (a difference among them) be closed over WITH A
REASON, so a closed month's statement need not tie.

**Fix.** *The form.* The reconciliation now carries the owner's walk:
`outstandingPayments` / `outstandingReceipts` (every unclaimed entry — this
period's and earlier ones' alike, split by sign), `computedClosingSen` = books
− outstanding + what is on the bank and not in the books, `unexplainedSen` =
the bank's printed closing minus that, `tallies` (consistent and unexplained
= 0), and `reconciled` = tallies with nothing on the bank left to decide. The
identity and the old figures stay for what still reads them. The panel
(`ReconciliationPanel`, `BankStatementTab.tsx`, shared with the month view)
is that walk as a table — Closing per the books / Add: payments in the books
the bank has not paid yet (N items) / Less: receipts … / On the bank, not in
the books (N still to decide) / Closing per the books after outstanding items
/ Closing per bank statement — ending on **✓ Tallies** or **✗ Off by RM x**,
with an *Unexplained* row only when there is one. April now reads *"Reconciled
— the books, allowing for 1 outstanding item, come to the bank statement's
closing."* The "brought forward" line and the "made up of" list are gone;
the two books tables are ONE — *Outstanding items — in the books, not yet on
the bank (N)*, each with date and who (owner: 全部就是 outstanding items，一张
表列完). The printed statement (`bank-reconciliation-pdf.ts`) walks the same
way, from the books to the bank, and refuses to be filed when it does not
tally.

*The lock.* `mayLockMonth` takes `computedClosingSen`, `closingStatementSen`,
`unexplainedSen`, `tallies`; a month closes when it has a statement, nothing
to decide, consistent figures, end-to-end coverage, a printed closing and
tallies — and otherwise cannot close: `not_tallied` names both figures and
the gap. The reason escape (`reason_required`, `needsNote`, the reason box)
is gone; `lock_note` is written null and the column stays for the locks that
were closed with one. The Close button (`BankMonthTab.tsx`) is off until the
month can close and says which condition is missing.

*The old file.* `POST /accounting/bank/statements/:id/period { month }`
(`bankStatementPeriod`) re-files a statement as its month's — period = the
1st to the last day — moving no line and no match; a movement outside the
month refuses (`month_mismatch`), a closed month refuses. The statement
header offers **This file is April 2026's statement** whenever the file does
not already cover its month (owner: 可以，没有问题，这只是显示问题吧).

Pinned by `bank-reconcile.test.ts` (April in the round: outstanding payment
counted, computed closing reaches the bank, tallies and reconciled; a
receipt line; an earlier period's entry among the outstanding items; a
movement still to decide tallies but is not reconciled; an unexplained
remainder does not tally; no closing cannot tally), `bank-lock.test.ts`
(rewritten: tallies closes, outstanding items close, not_tallied names both
figures, no_closing / not_covered / inconsistent / still_open / empty_month,
no reason escape), `backend/tests/bankRoutes.test.ts` (April on the HLB
account: the form, the lock without a word, still_open; the wrong-month
quiet file is `not_tallied`; the period route sets the month, refuses an
outside date and a closed month), `BankStatementTab.test.tsx` (the walk and
its rows, off-by, still-to-decide line, one outstanding table, the re-file
button), `BankMonthTab.test.tsx` (the button off with the reason; on when it
can close; no reason box) and `bank-reconciliation-pdf.test.ts` (the walk
from the books, the unexplained step, one outstanding table). Proved RED on
the unfixed tree (20 backend + 12 frontend), then GREEN.

**Ref.** acc/bank-recon-wording, 2026-09-11.
