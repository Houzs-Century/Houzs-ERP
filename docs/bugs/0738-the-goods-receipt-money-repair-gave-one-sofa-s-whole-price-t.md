## The goods-receipt money repair gave one sofa's whole price to every one of its compartment rows [high]

**白话.** 我们写了一支程式，要把账本上货收单的钱抄回 ERP。第一次跑的是**试算**，
没有真的写。试算一打开就看到问题：**一张沙发的钱被抄了三次。** 一张沙发在账本里是
一行，在 ERP 里是一个部件一行，程式把整张沙发的价钱放到了每一行上。整批算下来会
凭空多出 **RM 199,232.36**。**一分钱都没有写进去** —— 因为这支程式预设是试算，要
真的写还得另外打一句确认。这就是「先试算」存在的理由。

**Symptom.** `repair-gr-money-from-book.mjs`, run in its default `MODE=plan`
against production —
[34302355074](https://github.com/Houzs-Century/Houzs-ERP/actions/runs/34302355074),
book cut `2026-09-09T00:18:49Z` — printed the defect on the first document it
reached:

```
HC-GR-000815 (GR-000815): RM 2867.43 -> RM 8602.29  (RM 5734.86)
    5527-Console  unit RM 0.00 -> RM 3373.45   disc RM 0.00 -> RM 506.02   line RM 0.00 -> RM 2867.43
    5527-1A(LHF)  unit RM 0.00 -> RM 3373.45   disc RM 0.00 -> RM 506.02   line RM 0.00 -> RM 2867.43
...
agree already 263 · would change 105 · refused for real stock movement 0 · refused for a missing line key 29
money: RM 87595.43 -> RM 286827.79  (RM 199232.36)
```

`GR-000815` holds exactly ONE line in the account book — `RDS-5527 SOFA`, DtlKey
`209355`, `UnitPrice 3373.4500`, `SubTotal 2867.43`. The ERP holds three
compartment rows for it. The plan proposed to put RM 2,867.43 on each.

**Root cause, traced.** A sofa is ONE line in the book and one ERP row PER
COMPARTMENT (migs 0273/0280), and `scm.grn_items.linked_ac_dtlkey` therefore
carries the same key on every row of one build — deliberately: *"every ERP row
behind this AutoCount line gets the SAME key"*
(`src/scm/lib/autocount-line-keys.ts:155`). The module paired each ERP row to
its book line and wrote that line's whole `SubTotal` onto it, so the money was
multiplied by the compartment count. The document total was then summed over
ROWS, so the header inherited the same multiplication.

This is the decomposition trap the reconcile itself is built around — its
`lib/transfer-counter-verdict.mjs` compares a FRACTION precisely so that "one
book line, six ERP rows" cannot read as a defect — and the repair was written
without it.

**Nothing was written, and that is the finding.** `MODE=plan` is the default,
`MODE=apply` additionally requires `CONFIRM="I HAVE REVIEWED THE DRY-RUN"`, and
the plan is what caught it. Release discipline's plan-default rule
(`scripts/check-release-discipline.mjs`) is the only gate that would have — the
code compiled, the module's own eleven tests passed, and every one of them was
about a receipt with one ERP row per book line.

**Fix.** Rows are GROUPED by the book's line key. The book's figure lands on the
group's LEAD row — the first ERP row of that book line, which is the row the
importer put the money on — and every other row is set to zero in
`unit_price_sen`, `discount_sen` and `line_total_sen`. That is this repo's own
sofa convention, stated by `apply-sofa-compartment-corrections.mjs`: *"the lead
piece keeps the lead row's own unit_price_sen and its own total column verbatim;
every other piece is 0 in both"*. The document total is summed over DISTINCT
book lines, never over rows.

**Proved RED first**, against `GR-000815`'s real book line read out of the
committed cut rather than typed, so the fixture cannot drift from the book:

```
✖ three compartment rows of ONE sofa take the book's price ONCE, on the lead
  AssertionError: every other compartment is zero in both columns
    actual: 286743, expected: 0
✖ a receipt whose sofa already carries the book's money on its lead plans nothing
  AssertionError: the book prices this receipt and the ERP does not hold that figure
    actual: 'write'
```

then green — `node --test backend/scripts/lib/*.test.mjs` → `pass 242, fail 0`.

**The lesson, and it is not "be careful".** Every one of the module's original
tests was built from `erpAsImported()`, which turns the BOOK's own lines into
ERP rows — one row per book line, by construction. A fixture generated from one
side of a comparison cannot express the shape where the two sides have different
grain, so the suite was structurally incapable of seeing this. The regression
test is the first in that file to build its ERP rows independently of the book's
row count. **When two systems hold the same fact at different grain, at least
one test must state the grain explicitly rather than deriving it.**

**Ref.** fix/ac-align-so-po-gr, 2026-09-09. The repair itself is
`docs/bugs/0737`.
