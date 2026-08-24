## The fee cell pinned the price at the FIRST DIGIT typed — the verdict flipped mid-keystroke [high]

<!-- area: Sales orders + pricing -->

**白话.** 修完「新单运费打不进去」之后，又出第二个问题：打 250，格子卡在 RM 2。原因是
判断「这一格是改价还是打折」的逻辑每敲一个键就重新判一次。你敲「2」，单价变成 RM 2；这
时行上「有价钱了」，下一瞬间格子就切换成「打要收多少」模式；接着敲「25」，25 比 2 大，
系统认为「你想收的比运费还多」，什么都不记，格子弹回 2.00。贴上 250 反而没事，因为贴上
是一次过。现在这个判断每一行只做一次、锁死：本来就有价钱的行是「打要收多少」，从 0 开始
打的行整段编辑都是普通单价，存档重开之后才变。

**Symptom.** New SO, add a delivery-fee line, TYPE 250: the cell sticks at
RM 2.00 — the first digit — and no further keystroke changes it. PASTING 250
works. Reported with a screenshot minutes after #2527 deployed.

**Root cause (traced, and it is #2527's own fix).** #2527 made fee-vs-price
depend on `feeGrossSen > 0`, evaluated LIVE on every render:

1. gross 0 → plain-price mode → keystroke "2" writes `unitPriceSen: 200`;
2. gross is now positive → next render flips the cell to amount-to-charge;
3. keystroke "25" → 2500 ≥ gross 200 → "a higher figure books no discount" →
   writes nothing; the sync-back effect reformats the box from the net: 2.00.

Paste survives because it is ONE change event: the whole "250" lands while the
verdict still says plain price. #2516's comment already said the cell's meaning
must never flip under the operator's hands; #2527 built exactly that flip at
the 0→positive boundary.

**Fix.** `editsFeeAsDiscount` is replaced by `lockedFeeSemantics(prev,
isFeeCode, grossSen)`: the verdict is made ONCE per mounted line, from the gross
the line had when it became a fee line, and held in a ref. A line that ARRIVES
priced edits as a fee; a line authored from 0 stays a plain unit price for the
whole edit session and flips only after save + re-mount. Leaving fee code (a
product picked over the line) resets the verdict, so it cannot leak across a
line's reuse.

The regression test is the keystroke sequence itself — verdict at gross 0, then
200, then 2500, then 25000, asserted plain-price at every step — so the flip
cannot come back as a third same-day entry.

**The lesson, named.** Twice in one day the arithmetic was right and the
QUESTION it answered was re-asked at the wrong time. First "should this be a
discount?" was never asked (always-fee), then it was asked once (gross at
render), then per keystroke. State that decides an input's SEMANTICS must be
sampled when editing begins, not derived from the values the editing itself is
changing.

**Ref.** fix/fee-cell-semantics-frozen-per-edit, 2026-08-20. Third entry of the
fee-cell chain (#2516 → #2527 → here), same day.
