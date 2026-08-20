## Stock Card valued goods we do not own, and a line marked FREE on a new order was invoiced at full retail [high]

<!-- area: Inventory, costing, FIFO -->

**白话.** 两件事，都跟钱有关。

一、**电脑版的 Stock Card 把「寄卖货」也算成我们的钱。** 寄卖货是供应商放在我们
仓库、卖出去才算我们买的货。那一页顶上的「FIFO Value」把寄卖的也乘进去了 ——
同一页下面那张「各仓库」的表却是不算的，所以同一个画面自己跟自己不一样。手机版
一直是对的（分「Owned value」和「Consignment (not owned)」两行）。现在电脑版一样。

二、**新单上打 RM 0 的那一行，会自己变回原价。** 同事把一行标成免费，存档之后
系统悄悄换回目录价，客人就照原价被开单了 —— **电脑和手机都一样**。只有在单子
存好之后再去改那一行，0 才留得住（而且手机连这个都留不住）。现在只要是同事**自己
打进去**的 0，新单也留得住。**没人碰过的 0 不算**（例如沙发是系统自己算价的），
这一点很重要：如果连那种 0 都当成「免费」，沙发就会以 RM 0 开单，那比原来的问题
严重得多。

---

**Symptom A — the Stock Card.** `/inventory/stock-card/:itemCode` printed a
"FIFO Value" that included consignment lots, while the per-warehouse table
directly beneath it excluded them. Same SKU, same screen, two answers.

**Root cause A (traced in source, not guessed).** `StockCard.tsx` summed
`qty_remaining x unit_cost_sen` over every row from `GET /inventory/lots/:itemCode`.
That route selected `*` from `v_inventory_lots_open`, whose only predicate is
`qty_remaining > 0` (mig 0307), and shipped the rows through untouched — it was
the ONLY lot feed that did not carry a consignment verdict.
`/breakdown/:itemCode` in the same file has skipped consignment lots on
`isConsignmentLotSource` since BUG-HISTORY 2026-07-25, and `/reservations` has
STAMPED `is_consignment` on every row it returns; only this one said nothing, so
its one consumer had nothing to filter on.

**Fix A.** `GET /inventory/lots/:itemCode` stamps `is_consignment` per row from
the same one classifier (source-derived, never the warehouse flag — a PCR
mis-posted into a normal warehouse defeats that). `buildStockBreakdown` became
generic over a structural `StockLotLike` so BOTH lot feeds go through the ONE
transform instead of gaining a third filter, and the desktop stat is now "Owned
Value" with a "Consignment (not owned) · N units" caption beneath it, matching
mobile.

**Test A.** `backend/tests/inventoryLotsConsignment.test.ts` (RED:
`expected 260000 to be 100000` — RM 1,600 of a supplier's goods counted as ours)
and `frontend/src/pages/scm-v2/stockCardOwnedValue.test.tsx`, which mounts the
real page and RED-failed on the RM 2,600.00 total being present.

---

**Symptom B — RM 0 on a new order.** Staff mark a line free. The order saves, and
the line comes back at the catalogue price. On BOTH desktop and mobile. Editing
that line afterwards fixes it at the desk; on mobile even the edit re-priced it.

**Root cause B (traced in source, not guessed).** The backend believes a typed 0
only when the client says so — `erpLineTrust` returns `'operator-zero'` on
`zeroPriceIntended === true`, and a bare 0 means "not provided" and takes the
catalogue fill (`scm/lib/mfg-pricing-recompute.ts`). `erpLineTrust` was called at
exactly TWO sites, both line writes (`mfg-sales-orders.ts` add-line and line
PATCH). **SO CREATE used a plain per-request boolean**
(`const trustOperatorSelling = !(await isPosTabletCaller(c))`) and handed the same
value to every line, so `zeroPriceIntended` was never consulted on that path at
all. On the client the claim was a three-line arrow INSIDE
`SalesOrderDetail.tsx`, so the create surfaces and the whole of mobile had no way
to make it:

| | new SO line at RM 0 | existing line edited to RM 0 |
|---|---|---|
| desktop | reverted to catalogue | 0 sticks |
| mobile | reverted to catalogue | reverted to catalogue |

**Fix B.** Create now asks the same helper per line —
`erpLineTrust(createPosTablet, Number(it.unitPriceSen ?? 0), it.zeroPriceIntended)`
— with the POS lookup still resolved once per request (it does I/O and cannot
vary within one). The client claim moved to
`frontend/src/vendor/scm/lib/zeroPriceClaim.ts` and is now made by desktop create,
mobile create, mobile line-add and mobile line-PATCH as well as the two desktop
sites it already served.

**The second argument is the whole safety, and it is REQUIRED.** Claiming EVERY
0 would have been a much worse bug than the one being fixed: an unpriced
catalogue SKU, and every sofa build (the server prices those from the Model's
module SKUs at save), reaches the wire at 0 — the trust arm wins over that
arithmetic, so a blanket claim books sofas at RM 0. So the fact is threaded from
the price INPUT itself: `priceAuthored`, a client-only flag on the line draft
(same shape as `overriddenKeys`, never persisted), set when the operator types
in the price box. A line seeded from a PERSISTED row — desktop copy-to-new-SO,
mobile edit-prefill — is authored by construction, which is what keeps the mobile
edit-DRAFT road (it re-CREATES the order) from handing a free line back to the
catalogue.

**Test B.** `backend/tests/zeroPriceCreatePath.test.ts` (RED: `expected [
'erpLineTrust(', 'erpLineTrust(' ] to have a length of 3 but got 2`) and
`frontend/src/vendor/scm/lib/zeroPriceClaim{,Wiring}.test.ts`. Two existing
wiring tests were EXTENDED, not relaxed — `operatorZeroPriceWiring` and
`soTotalFloorRemoved` both counted the call sites at 2 and now name the third.

**One thing deliberately NOT changed, and the open question it leaves.**
`SalesOrderDetail`'s staged line-ADD passes `authored: true` unconditionally, as
it has since #2425. That is today's shipped behaviour and it is outside this
defect, but it carries the same hazard as a blanket claim: a NEW line whose SKU
has no `sell_price_sen` shows 0.00 in a price box the operator may not even be
able to edit (`canEditPrice` is admin/hatch-sales only), and the claim then
persists RM 0 where the server would have priced it. Whether an ADD on an
existing SO should require `priceAuthored` too is a judgement about how staff use
that screen, so it is the owner's call rather than a provable defect. Flagged
here rather than changed.

**Ref.** PR #2565, 2026-08-20.
