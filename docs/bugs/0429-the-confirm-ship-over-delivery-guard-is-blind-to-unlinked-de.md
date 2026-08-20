## The confirm-ship over-delivery guard is blind to unlinked delivery lines — the DO-005 hole, one chokepoint further in [high]

<!-- area: Delivery, DO, returns -->

**白话.** 一张送货单如果整组行都没连到销售单的那一行（`so_item_id` 是空的），货照样出，
但系统数「这张单出了多少」的时候看不到它 —— 因为它是按「销售单第几行」来数的，没连上就
数不到。这正是 `2990-DO-2607-005` 把 `2990-SO-2606-019` 的货送第二次却没人拦的原因：六
行全是空的连结。开单和加行那两个入口 2026-08-04 已经补上拦截了；但「草稿单 → 确认出货」
这个真正扣库存的关口没有 —— 它唯一的出货检查就是那个看不到空连结的守卫。这次给守卫补上
按「货号」数的版本：只有当销售单本来就有这货、而且已经全部送完，空连结那行才拦；正常的
分批 / 多张送货单还是照送。**先做守卫本体和测试，接到关口那一步要改 `delivery-orders-mfg.ts`，
按指示留到 `fix/cross-tenant-leaks-round2`（#2406）合并后再接，避免撞车。**

**Symptom.** None newly reported — this hardens the exact chokepoint that let
`2990-DO-2607-005` ship `2990-SO-2606-019`'s goods a second time (the CRITICAL
entry of 2026-08-04, `docs/unlinked-line-duplicate-coe.md`). The create and
add-line paths were closed then; the DRAFT→shipped CONFIRM path — the single
point where a draft's stock actually leaves — was not.

**Root cause (traced in source).** The confirm-ship guard in
`routes/delivery-orders-mfg.ts` (Status PATCH, the `SHIPPED_STATES` block ~:5055)
builds `linkedQty` by `if (l.so_item_id)` and drops every line without one, then
calls `findOverDeliveredSoItems`, which keys entirely by `so_item_id`. A line
with `so_item_id = null` therefore contributes nothing to the tally and is
invisible to the check — yet `deductInventoryForDo` reads the DO's OWN lines, so
the goods leave regardless. So an unlinked draft DO of an already-delivered SO
line can be confirmed and ship without the over-delivery guard ever counting it.
`findUnlinkedSoLines` (2026-08-04) closes this on `POST /` and `POST /:id/items`
but is not called on the Status PATCH.

**Fix.** `lib/do-over-delivery.ts` gains `findOverDeliveredUnlinkedItems(
unlinkedByItemCode, openByItemCode)` — a pure, quantity-aware guard that flags an
unlinked line only when the named SO ordered that item code AND has no open qty
left for it (item_code present with 0 open). An item the SO never ordered (code
absent) is genuinely ad-hoc and never flagged, and a partial / multi-DO split
with open qty remaining still ships. Comparison is item_code-only, sharing
`itemCodeKey` with `do-unlinked-so-lines.ts` so all sides agree on "the same
item". **Guard + tests only in this PR; the Status-PATCH wiring is a caller edit
to `delivery-orders-mfg.ts` deliberately deferred behind #2406 (round2) to avoid
a merge collision** — until wired, the confirm-path cap stays linked-only (noted
in `docs/modules/delivery-order.md`). The class, again: a pure guard only sees
the fields it is HANDED; when the caller drops the field, no lib change recovers
it — the caller has to stop dropping it.

**Test.** `backend/src/scm/lib/do-over-delivery.test.ts` — new file, 13 tests:
an unlinked duplicate against a fully-delivered SO is caught, and a partial /
multi-DO split is still allowed, plus ad-hoc / case / whitespace / multi-offender
cases and the full six-line DO-005 shape. Also locks `findOverDeliveredSoItems`,
which had no test of its own.

**Ref.** `fix/over-delivery-unlinked-blind-spot`, 2026-08-20.
