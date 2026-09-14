## A bank line whose decision changed under it kept its old empty ticks [medium]

<!-- area: Accounting + GL -->

**Symptom.** Hong Leong July, the PBB credit of RM 8,131.69 on 2026-07-06.
First drawn as "a card payout — check which" with six reports to choose
from. After the owner recorded other payouts, the same row read "one payout
for several reports — 3 of PBB's reports add up to RM 8,131.69 exactly …
Check them and record it", but no report was ticked, "Not this one? 4 other
report(s)" sat alone, and Money received was dead. Owner 2026-09-14: 什么意思？
A page reload showed the three reports ticked and the button live.

**Root cause (traced).** The matcher decides every line again on each read
(docs/bugs/0815). Once the other reports were paid, only one combination of
PBB's remaining reports added up to the credit, so the fresh decision became
PAYOUT_SPLIT with the three reports. The row's ticks (`picked` in `OpenLine`)
are React state seeded ONCE, on mount, from the decision the row was born
with; the row was keyed on the line id alone, so the changed decision
re-rendered the same instance and its empty state survived — the labels
render only the ticked reports of a decided line, hence none.

**Fix.** `frontend/src/pages/scm-v2/BankStatementTab.tsx`: rows are keyed on
the line AND its decision (`decisionKey`: id, kind, matched report, split
allocations). A changed decision remounts the row, whose ticks are seeded
from what the matcher decided now — the three reports ticked, "Money
received — 3 reports" live; a decision that has not changed keeps the row and
whatever the operator has ticked by hand. Shared by the file screen and the
month.

Pinned by `frontend/src/pages/scm-v2/BankStatementTab.test.tsx`: a row drawn
undecided, re-read as a three-report split, shows the three ticked and posts
exactly that allocation.

**Ref.** fix/bank-line-reseeds-on-fresh-decision, 2026-09-14.
