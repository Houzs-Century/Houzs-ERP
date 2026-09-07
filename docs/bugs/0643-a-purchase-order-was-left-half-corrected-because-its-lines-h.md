## A purchase order was left half corrected because its lines had already been carried from the sales order [medium]

**Plain version for the owner.** 一张单上有两张一模一样的沙发。销售单那边先补好了，
补好之后系统会顺手把采购单的货号一起改掉 —— 结果轮到采购单自己要补的时候，系统看它
的货号「已经是对的」，就以为没有两张沙发了，於是整张拒绝，采购单只改了货号、少了六
行零件。钱一分没动，但采购单是半成品。

**Symptom.** On the production apply run for the 2026-09 sofa round
(run 33891638140, 2026-09-04), `HC-PO-009024` was refused:

```
HC-PO-009024: REFUSED — money would move — total 0 -> 0, charged 190000 -> 95000.
```

Its two lines had been corrected from `9050-1S` to `9050-1A(LHF)`, but the six
pieces the build owes them (`1NA`, `CNR`, `1A(RHF)` for each of the two sofas)
were never inserted. Every other document in the run applied and verified. The
same build's SALES order, `HC-SO-012025`, is complete and correct.

**Root cause (traced, not guessed).** Two things in sequence, neither wrong on
its own.

1. A correction that names both an SO and its PO processes the SO first, and the
   SO branch then CARRIES the corrected code down to every PO line dedicated to
   an SO line it touched. That is the feature that keeps the pair from drifting,
   and it fired correctly here — the run log shows
   `-> 1 PO line(s) follow 1A(LHF)` twice.
2. `splitBuildCopies` decided how many sofas a document holds by counting
   PLACEHOLDER lines — rows whose code is not one of the target pieces. After
   step 1 neither PO line was a placeholder any more, so it saw ZERO placeholders
   and one sofa, paired both rows into it, and handed a two-row sofa to the money
   check. Two rows at 95,000 sen each cannot both ride "the price is on the first
   piece", so the money guard refused — correctly, on a premise that was wrong.

Observed, not inferred: the refusal names `charged 190000 -> 95000`, which is
exactly the two carried lines being read as one sofa, and prod now holds two
`9050-1A(LHF)` lines on that PO at 95,000 each.

**Fix.** `splitBuildCopies` no longer asks "is this a placeholder". It counts
each code and divides by how many the target list uses: a code the build does not
use is one sofa per row, a code the build uses N times is one sofa per N rows,
and the number of sofas is the largest of those. It stands only if EVERY code
divides exactly — anything else is refused with the arithmetic in the message,
rather than guessed. That reads `HC-PO-009024` as two sofas of one `1A(LHF)`
each, and it still reads `HC-SO-011008` (`1A+1NA+CNR+1NA+1A`, two `1NA` rows) as
ONE sofa, which the naive "a repeated code means a repeat sofa" rule would not.

The money guard is untouched. It refused a wrong plan and that is what it is for.

**Proved.** `node --test scripts/lib/*.test.mjs` — 84 tests, 0 failures. Four
new cases, one of them the exact prod row shape from run 33891638140. The RED
evidence for the change is that production refusal itself: the old rule was run
against the real rows and reported the message quoted above.

Dry-run against prod after the fix: `HC-PO-009024` plans `2 x
1A(LHF)+1NA+CNR+1A(RHF)`, six inserts, `money total 0, charged 190000` unchanged.
Every other document in both rounds re-plans as `keep`.

**Ref.** `fix/sofa-copies-after-carry`, 2026-09-04.
