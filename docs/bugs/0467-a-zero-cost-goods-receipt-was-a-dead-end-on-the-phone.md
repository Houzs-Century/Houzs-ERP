## A zero-cost goods receipt was a dead end on the phone [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** 后台拒绝零成本收货时讲得很清楚，而且给了两条出路：填上供应商送货单上的单价，
或者在**那一行**打勾「Received free」并写原因。电脑版两样都有。手机版**一样都没有**
—— `zeroCostAck` 在整个 `frontend/src/mobile` 里一次都没出现过，收货画面只有「Post」和
「Cancel」，连转单精灵的提示都写着「open the receipt on desktop」。仓库地面上拿着手机的
收货员，看到一个正确、看得懂、指名两个修法的拒绝讯息，而那两个修法都不在他手上那台
机器里，只能去找电脑。拒绝讯息本身两边都显示正常 —— 缺的是**补救的界面**。

**这不是一键豁免。** 每一行各自决定：填价，或打勾＋写原因；只要还有一行没交代，
Post 就不放行。`docs/modules/grn.md` 已经写明这个逃生口**故意**放在行上而不是对话框上，
「一键把整张单说成免费」正是这道闸要防的反射动作。

**Symptom.** `PATCH /scm/grns/:id/post` answers 409 `zero_cost_receipt`, naming
the offending lines and both remedies. On the phone neither remedy exists.

**Root cause.** Two halves. (a) `MobileModuleDetail`'s `grns` case offers only
Post and Cancel, and no mobile file mentions `zeroCostAck`. (b) `authed-fetch`
parsed the refusal body, composed the operator's sentence and threw the parse
away, so a surface could show the refusal and nothing else.

**Fix.** New shared `frontend/src/vendor/scm/lib/zero-cost-refusal.ts` —
`parseZeroCostRefusal` / `zeroCostRefusalText` / `zeroCostRefusalFrom`.
`authed-fetch` now composes the SAME sentence through it (moved, not rewritten)
and attaches `status` + the raw `body` to the thrown error, exactly as its
terminal error path already does. New `frontend/src/mobile/MobileGrnZeroCost.tsx`
turns that into a per-line bottom sheet: a unit price, or a "Received free" tick
with its reason, written through the same
`PATCH /grns/:id/items/:itemId` desktop uses (the only route that clears the gate
without inventing a price — the three ack columns move together server-side in
`zeroCostAckColumns`), then the original `PATCH /grns/:id/post` runs again.
`MobileModuleDetail`'s action footer captures the refusal and opens it; the
convert wizard's message no longer sends the receiver to a PC.

**Test.** `frontend/src/vendor/scm/lib/zero-cost-refusal.test.ts` (parser +
sentence) and `frontend/src/mobile/MobileGrnZeroCost.test.tsx`, which drives the
real sheet with `authedFetch` faked and pins both writes, the second refusal
being shown rather than swallowed, and that Post stays disabled while any line
is unanswered. Run RED first: `Failed to resolve import "./zero-cost-refusal"`
— neither module existed.

---
