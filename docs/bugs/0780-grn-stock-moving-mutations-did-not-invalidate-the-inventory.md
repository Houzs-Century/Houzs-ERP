## GRN stock-moving mutations did not invalidate the inventory cache, so Stock Card showed stale on-hand [medium]

<!-- area: Purchase orders + GRN + PI -->
<!-- status: fixed -->

**白话.** 一张已过账（POSTED）的收货单，改了它的明细——加一行、改数量、删一
行——或用「从采购单转收货」一次过账，货其实已经真的进/出了库。可是另一个开着的
屏幕上的库存卡 / 库存列表还显示旧的在手数量，要手动刷新、或等 30 秒重新打开才会
对。改收货仓库位置再保存，也一样。原因是这几个操作做完后，程序只叫「这张收货单」
和「收货单列表」重新拉数据，忘了叫「库存」重新拉——而「过账」「取消」这两个操作
本来就叫了。修法就是把「叫库存重新拉」这一句，补到这五个会动库存的操作里。看得见
库存不准的操作：从采购单转收货、改仓库、加/改/删明细。

**Symptom.** Found 2026-09-10 while adding a manual/extra-item add-row to
`GoodsReceivedDetail.tsx` (which calls `useAddGrnItem`). On a POSTED GRN, a line
add / edit / delete — and the "From Purchase Order" append and a whole-PO convert
— move inventory on the server, but a mounted Stock Card / inventory list kept
the old on-hand until React Query's 30s `staleTime` lapsed on a remount. Traced
by reading the frontend invalidation sets against the rule `docs/modules/grn.md`
§1 already states: "every mutation that can move inventory also invalidates
`['inventory']`."

**Root cause (traced).** In `frontend/src/vendor/scm/lib/grn-queries.ts`, five
mutation hooks that move stock server-side invalidated only `['grn-detail']` +
`['grns']` in their `onSuccess`, omitting `['inventory']`. The server side was
verified by reading the handlers in `backend/src/scm/routes/grns.ts` (line numbers
drift — resolve with `gen:route-locator`):

- `POST /:id/items` writes an `IN` movement (`writeMovements` at `:3037`) +
  `recomputeSoStockAllocation` — `useAddGrnItem`.
- `PATCH /:id/items/:itemId` writes delta `OUT`/`IN` movements (`:3345`) —
  `useUpdateGrnItem`.
- `DELETE /:id/items/:itemId` writes a reversing `OUT` (`:3538`) —
  `useDeleteGrnItem`.
- `PATCH /:id` on a warehouse change writes `OUT` (old) + `IN` (new) (`:2692`) —
  `useUpdateGrnHeader`. Its sole caller (`GoodsReceivedDetail.tsx:377`) adds no
  compensating invalidation.
- `POST /from-pos` auto-posts via `postGrnAndRollup` (`:1868`), which writes the
  `IN` — `useGrnFromPos` moves stock on EVERY successful convert, not only when
  the GRN was already posted.

Only `usePostGrn` and `useCancelGrn` carried the `['inventory']` invalidation, so
the client never refetched on-hand for the other five paths.

**Fix.** Added `qc.invalidateQueries({ queryKey: ['inventory'] })` to the
`onSuccess` of all five hooks (invalidation only — no behaviour change; an
un-mounted query is a no-op refetch, the same generous posture `sharedInvalidate`
documents). Pinned by
`frontend/src/vendor/scm/lib/grn-stock-invalidation.test.tsx` (5 tests, one per
hook, asserting the success path invalidates the `['inventory']` root): proved RED
on the pre-fix tree (all 5 `expected false to be true`), GREEN after.

RULED OUT, so the next sweep does not re-chase them:

- `useCreateGrn` — NOT a gap. Its only caller `GrnNew.tsx:716` follows a
  non-draft create with `post.mutateAsync` (`usePostGrn`), which already carries
  the invalidation; its minimal `onSuccess` is the deliberate create-then-navigate
  shape.
- Mobile — NOT a gap. `frontend/src/mobile/sharedInvalidate.ts:97` folds
  `STOCK_ROOTS` (`["inventory", ...SO_ROOTS]`, `:75`) into the `grns`
  module-shared roots, and mobile imports none of the five vendored hooks; its
  only item-level write, `MobileGrnZeroCost.tsx`, PATCHes items on a DRAFT GRN
  before the first post (no movement), delegating invalidation to the caller's
  `onPosted`.

Guide `docs/modules/grn.md` §1 stock-side-invalidation rule updated to name the
full set.

**Ref.** claude/priceless-chaum-35a0dd, 2026-09-10.
