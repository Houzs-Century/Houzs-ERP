## The unlinked over-delivery guard is now WIRED into the ship-confirm — the DO-005 hole is closed at the deduct chokepoint [high]

<!-- area: Delivery, DO, returns -->

**白话.** 上一条把「按货号数的守卫」和测试做好了，但还没接到真正扣库存的那一步。这次接
上了：草稿送货单点「确认出货」的那一刻，系统除了照旧检查连到销售单行的那些行，还会把没连
结的行按货号加起来，跟这张送货单指名的那张销售单「还欠多少」对一对 —— 如果那货销售单本来
就有、而且已经全部送完，就挡下来（409），货不会第二次出门。正常分批 / 多张送货单还是照送，
销售单没有的临时货（换的零件、样品）也照过。`2990-DO-2607-005` 那种六行空连结、把货送第二
次的洞，现在在扣库存的关口就被拦住了。

**Symptom.** None newly reported — this LANDS the guard the previous entry
built. Until this PR the confirm-path over-delivery cap was linked-only, so the
`2990-DO-2607-005` shape (a DRAFT DO whose lines carry no `so_item_id` for an
already-delivered SO line) could still be confirmed and ship the order's goods a
second time. The guard existed in `lib/do-over-delivery.ts` but nothing called
it at the chokepoint.

**Root cause (traced in source).** `routes/delivery-orders-mfg.ts` Status PATCH,
the `SHIPPED_STATES` first-ship block, built `linkedQty` via `if (l.so_item_id)`
— dropping every unlinked line — and called only `findOverDeliveredSoItems`
(keyed by `so_item_id`). A line with `so_item_id = null` contributed nothing and
was invisible, yet `deductInventoryForDo` reads the DO's OWN lines, so the goods
left regardless. The wiring for `findOverDeliveredUnlinkedItems` was deferred
behind #2406 (round2) to avoid a merge collision; round2 has now merged.

**Fix.** In the same `SHIPPED_STATES` block: the `delivery_order_items` select
gains `item_code`; lines WITHOUT `so_item_id` are summed into
`unlinkedByItemCode`; `openByItemCode` is aggregated from
`soDeliverableRemaining` for the header's named `so_doc_no`, per ordered
`item_code` (that engine excludes DRAFT + CANCELLED deliveries via
`do-unlinked-coverage.ts`, so THIS draft being confirmed is already out of the
tally — "this DO excluded" holds for free); `findOverDeliveredUnlinkedItems`
runs alongside the existing linked check, and either returns **409
`over_delivery`**. A partial / multi-DO split within the open qty still ships; an
ad-hoc code the SO never ordered is never flagged. `openByItemCode` is aggregated
under `itemCodeKey` so two SO lines of the same normalised code sum rather than
overwrite. round2's company-scope predicates in this file are preserved —
`so_doc_no` was only added to the already-`scopeToCompanyId`-scoped header load.

**Test.** `backend/tests/doOverDeliveryUnlinkedRoute.test.ts` — new file, 3
route-level tests driving `patchDeliveryOrderStatusHandler` through a fake
PostgREST: the unlinked duplicate is refused 409 (and the draft stays a draft —
refused BEFORE the flip), a legit multi-DO split still ships, and an ad-hoc line
the SO never ordered is not flagged. The harness's `.is(col, null)` filters
faithfully (the sibling harness leaves it a no-op), so the coverage engine does
not misread a linked line as unlinked coverage. Pure guard stays pinned by
`lib/do-over-delivery.test.ts`.

**Ref.** `fix/over-delivery-unlinked-blind-spot`, PR #2522, 2026-08-20.
