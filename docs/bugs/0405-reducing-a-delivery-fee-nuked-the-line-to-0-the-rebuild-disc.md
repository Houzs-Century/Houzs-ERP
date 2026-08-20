## Reducing a delivery fee "nuked the line to 0" — the rebuild discarded the operator's discount [medium]

<!-- area: Sales orders + pricing -->

**白话.** 想把运费从 250 改成 125，结果那一行直接变成 0，整行还不见了。原因分两层：
运费这一行是系统**算出来**的，不是存起来的 —— 你改单价，系统下一秒就把整组运费行删掉
重算，你打的数字根本没被读过（行「消失」是真的：删了重插）。而正路 —— 在那一行打
**折扣** —— 系统也收下了，却在同一次重算里把折扣写回 0。等于降运费没有任何一条路走得
通。现在折扣会保留：单价还是算出来的 250，折扣 125，合计 125，跟单上其他降价一个写法。

**Symptom.** Editing a `SVC-DELIVERY` line's unit price 250 → 125 on the ERP SO
editor "saves", then the line reads 0 / vanishes. Reducing a PRODUCT line works
fine — this is delivery-fee-only, which is what made it look random.

**Root cause (traced).** Two layers, both by design and jointly a dead end:

1. The fee lines are DERIVED. Any line edit on an SO carrying a fee calls
   `rederiveDeliveryFee` → `recomputeDeliveryFeeCore`, which deletes the
   `SVC-DELIVERY*` set and rebuilds it from `computeSoDeliveryFee` (the 0214
   RPC). A typed unit price is never read; the edited row is genuinely deleted
   and replaced. One truth — owner 2026-08-07, "every ringgit is a LINE".
2. The sanctioned reduction — a line DISCOUNT, which the PATCH accepts bounded
   0..qty×unit on any line — was written back to `discount_sen: 0` by that same
   rebuild. So the discount saved, then the derivation it triggered erased it.

The only surviving lever, `SVC-DELIVERY-ADD`, is clamped
`Math.max(0, additionalFee)` — fees could go up but never down.

**Why not the other two designs.** A negative additional fee is a discount in
disguise on the printed SO and needs the non-positive-line guard loosened. A
per-order override field is header money without a line — the exact back door
the owner ruled out and 2990-SO-2608-006 already burned (mirror outliving its
lines).

**Fix.** `recomputeDeliveryFeeCore` now recovers each fee line's `discount_sen`
by `item_code` before the rebuild, clamps it to the rebuilt line's own total,
and re-applies it. The fee stays derived (unit 250); the reduction is the
operator's discount (125); total 125 — expressed exactly like every other price
reduction on an SO. The header mirror stamps the NET so Σ(lines) === header
still holds, and the audit row compares nets so an unchanged rebuild still
logs nothing.

Two guards worth naming: the `SVC-DELIVERY-ADD` gross is now recovered from
unit × qty instead of `total_sen` — with discounts surviving, `total_sen` is
net, and recovering the net as the next gross would compound the reduction on
every save (50 → 30 → 10 across three edits). And a component that disappears
on rebuild (base swapping to `SVC-DELIVERY-CROSS`) DROPS its discount rather
than migrating it to a line it never named.

Four cases in `soDeliveryFeeLineIntegrity.test.ts`; three fail on the unfixed
source, and the no-discount case pins byte-identical behaviour to before.

**Ref.** fix/delivery-fee-discount-survives, 2026-08-19. Same family as the
2026-08-07 back-door ruling; the operator-side answer to it.
