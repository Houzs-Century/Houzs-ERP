## #2516 turned the delivery-fee cell into a dead input on the SO create page [high]

<!-- area: Sales orders + pricing -->

**白话.** 昨天那个「运费格可以直接打要收多少」的改动，把新建销售单那边弄坏了。手动加一
行运费，打 250，一离开格子就变回 0.00，怎么打都没用。原因是新单上那一行运费本来就是 0，
系统把 250 当成「我要收 250」，於是去算折扣 = 0 − 250，负数被夹成 0，单价一次都没写进
去。而 Houzs 这边自己开的单，运费从来都是人手打单价的 —— 会叫伺服器自己算运费的那个
旗标只有 POS 交单才会送 —— 所以那一刻起，新单根本放不了运费。现在改成：那一行还没有价
钱的时候，格子就还是单价格；已经有价钱了，才是「要收多少」。

**Symptom.** New Sales Order, add a `Delivery fee` line by hand, type 250, press
Enter or click away: the cell reads `0.00`. Every retry does the same. Reported
by the owner with a screenshot within the hour of #2516 deploying.

**Root cause (traced).** #2516 routes fee lines through
`feeDiscountForAmount(feeGrossSen, typed)` with
`feeGrossSen = qty * unitPriceSen`. A hand-added fee line starts at
`unitPriceSen: 0` (`emptySoLine`), so the gross is 0 and:

    feeDiscountForAmount(0, 25000) = min(max(0 - 25000, 0), 0) = 0

The clamp is correct — a figure at or above the gross is not a reduction — but
the case is wrong. `unitPriceSen` was never written, and the blur handler
reformats from `feeAmountSen(0, 0)` = 0. Typing any figure at all is a no-op.

**Why it is worse than it looks.** `applyDeliveryFee` — the create flag that
makes the server derive a fee — is sent ONLY by the POS handover;
`git grep applyDeliveryFee -- frontend/src` returns nothing, and the route says
so at `mfg-sales-orders.ts:4477`. So a Houzs-authored SO has ALWAYS had its fee
typed in as a unit price, and #2516 removed the only way to do that. This was
not a cosmetic edge: between deploy and this fix, a new Houzs order could not
carry a delivery fee at all.

**Fix.** The discount reading applies only once there is a fee to reduce.
`editsFeeAsDiscount(isFeeCode, grossSen)` returns false at gross 0, so the cell
goes back to writing `unitPriceSen` — that is the initial fee entry, not a
reduction. An existing 250 fee still books 250 → 125 as a discount, untouched.

The GROSS decides, not the net, so a fee waived to zero keeps fee semantics —
otherwise waiving one would flip the cell's meaning and the next keystroke would
do something different from the last.

**What I got wrong, and the shape of it.** I assumed a fee line always carries a
server-derived gross. True on the detail page, false while authoring. The tests
in #2516 were all written against an existing 250 fee, so the whole suite passed
green over a case that could not work — the arithmetic was right and the
question of WHEN to apply it was never asked. `editsFeeAsDiscount` exists so
that question now has an executable answer rather than living inline in the JSX.

Five cases added, including the regression itself (`gross 0 -> not a fee edit`).

**Ref.** fix/delivery-fee-line-can-be-priced-when-new, 2026-08-20. Fixes #2516,
same day.
