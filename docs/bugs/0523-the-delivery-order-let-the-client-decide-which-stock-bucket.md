## The delivery order let the client decide which stock bucket to ship from [high]

<!-- area: Inventory, costing, FIFO -->

**白话.** 出货单以前是「浏览器说这一行是什么类别，就当它是什么类别」。类别不是标签
——它决定这一行的货算在**哪一格**库存里。类别送错或漏送，系统就跑去**空的那一格**
看有没有货，跟操作员讲「没货，还要出吗？」，然后又从**空的那一格**扣。货其实好好地
在同一个仓库里。

这是 0514 那条 bug 的**另外半边**：0514 修的是货**进来**（销售单／采购单／收货单／
寄售单），出货这半边一直没修。

**Symptom.** Not reproduced on production in this PR — the shape is 0514's,
proved there end to end on `HC-SO-2608-004` → `HC-PO-2608-003` →
`HC-GRN-2608-003` ("At BALAKONG WAREHOUSE: need 1, available 0 (short 1)" for a
receipt made minutes earlier into that same warehouse). What is proved HERE is
the code path, by a route-level reproduction: `backend/tests/doLineCategoryFromSku.test.ts`
drives the real add-line handler with a bedframe SKU and a request that says
`itemGroup: 'others'`, and on the unfixed tree the operator is shown a shortage
against `variantKey ''` and the row is stored as `others`.

How many document lines in production already carry a category that disagrees
with their SKU is **UNKNOWN** here and is deliberately not answered by this PR —
the read-only census is PR #2671.

**Root cause (traced).** `computeVariantKey(item_group, variants)`
(`shared/variant-key.ts`) composes a sofa's fabric / seat / leg — a bedframe's
fabric / gap / divan / leg — into the stock key **only** when the group is
`sofa` or `bedframe`; for `others`, `accessory`, `service`, `mattress` or null it
returns `''` by design (`ATTRS_BY_GROUP`). PR #2660 made the server resolve that
group from the SKU on the INBOUND documents and said in its own header why:
*"Fixing a client that loses it leaves the next client — mobile, an import, a
script — free to lose it again."*

`grep -rln "sku-category" backend/src/scm` returned four files, all inbound.
Nothing on the delivery side. The outbound routes read the group straight off
the request body:

- `delivery-orders-mfg.ts` `POST /` — `itemGroup: (it.itemGroup as string|null) ?? null`
  and `variantKey: computeVariantKey((it.itemGroup ...), ...)` fed BOTH the
  pre-flight stock check and `resolveShipCommitments`; `buildItemRow` then stored
  the same client value, and `deductInventoryForDo` keys its OUT from that stored
  column. So the check, the binding and the deduction all agreed — on the
  client's answer.
- `POST /:id/items`, `PATCH /:id/items/:itemId` — same.
- `delivery-returns.ts`, `consignment-notes.ts`, `consignment-returns.ts` — the
  same three shapes each. These have no pre-flight check; their movement is keyed
  from the stored group alone.

The convert paths were already safe and were NOT changed: `POST /from-sos` builds
its lines from `soDeliverableRemaining`, which reads `mfg_sales_order_items` —
a group the server already resolved — and the DR convert-from-DO copies the DO
line's row.

**Fix.** `resolveItemGroups` (`lib/sku-category.ts`, composed from the existing
`skuCategoryMap` + `lineItemGroup` — no second resolver) rewrites each
request line's `itemGroup` to `mfg_products.category` for its code,
company-scoped (`code` is shared between the two organisations — the reason
`grns.ts:287` gives), fail-soft. Owner 2026-08-22: 「正常来说就跟着 PO 里面的
SKU 啊，我的 SKU 也绑定跟 category 了啊」.

**It is a REWRITE of the line objects, applied once above every reader, and that
is the load-bearing part.** An inbound document reads the group in one place: the
row it writes. A delivery order reads it in three — the stock CHECK, the
commitment planner, and the stored row the OUT is later keyed from. Three
lookups can disagree; one assignment cannot, and a line that passed the check
against the bedframe bucket then deducting from the unclassified one would be
worse than the bug. The rewrite also reaches `isServiceLine` and the sofa dye-lot
/ whole-set guards, which read the same objects — so a sofa mis-declared as
`others` now meets the guards a sofa is supposed to meet.

Applied to create, single-add and the line PATCH on all four outbound documents.
The PATCH fires **only** when the request names `itemGroup` or `itemCode`: an
edit that touches neither is left exactly as it was, because repairing rows this
request did not touch is a different job.

`buildItemRow` moved to `lib/do-item-row.ts` — `delivery-orders-mfg.ts` is over
its size ceiling and the ratchet charges growth, and the move gives the row
shape a test seam. The route file ends 36 lines SMALLER than its merge base.

**Guard.** `backend/tests/doLineCategoryFromSku.test.ts` — 4 cases through the
real `addDeliveryOrderItemHandler` with a fake PostgREST. It pins both readings
in ONE request: the short-stock 409 the operator is shown names the SKU's bucket,
and the row stored carries the SKU's group, which is what the OUT is keyed from.
**Proved RED by deleting the guard: 3 of 4 failed**, reporting `variantKey ''`
and `item_group 'others'`. The fourth (an unclassified code keeps the caller's
value) passes either way by design. Plus 5 cases on `resolveItemGroups` in
`src/scm/lib/sku-category.test.ts`, including the fail-soft contract.

**Still open, deliberately not in this PR.** Existing rows are NOT repaired. A
line already stored with a category that disagrees with its SKU keeps it, and its
stock stays in whichever bucket it was keyed into. The count comes first
(PR #2671), then the repair decision is the owner's.

**Ref.** fix/the-outbound-side-resolves-its-own-category, 2026-08-23.
