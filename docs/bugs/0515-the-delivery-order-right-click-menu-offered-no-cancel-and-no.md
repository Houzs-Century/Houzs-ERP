## The Delivery Order right-click menu offered no Cancel and no Delivery Return [medium]

<!-- area: Delivery, DO, returns -->

**白话.** 老板在 Delivery Order 清单上按右键，看到的选单少了两样东西：一个是
Cancel（取消这张送货单），一个是 Transfer to Delivery Return（转成退货单）。他的话：
「DO 这一边没有问题，可是为什么没有 Cancel 呢？By right 每一个 Transaction Record
应该都可以右键（Right click）Move to Cancel，或者在 Draft 那边右键 Confirm 之类
的」，还有「我的 DO 也应该有右键 Transfer to Delivery Return，对吧？」

两样东西不见的原因不一样：

- **Cancel** 是系统里本来就有的功能，只是只做在「打开单据的那一页」，清单这边没有。
  当初不放上来的理由是：取消送货单会把库存倒回去，右键选单没有那一页的「确定吗」提
  示，怕人手滑。理由讲的是「少了一道确认」，不是「不该有这个功能」—— 所以这次把确
  认一起做上去，功能就可以放了。
- **Transfer to Delivery Return** 是「目的地那一页」没做完。转过去的画面
  （`/scm/delivery-returns/from-do`）本来就在，但它完全不看你是从哪一张送货单点进来
  的，所以就算加了这个右键，点下去也是跳到「全公司所有可退的送货单」那一大张清单，
  人还要自己再找一次。这次把它接上，点哪一张就只显示哪一张，而且数量先帮你填好。

**Symptom.** Owner, 2026-08-22, on the Delivery Order list's right-click menu:
no `Cancel`, and no `Transfer to Delivery Return`. Cancelling a delivery order
was reachable only by opening the document; raising a return from a specific
delivery was reachable only by opening the global returnable-lines picker and
finding the note again by hand.

**Root cause (traced).** Two separate causes, one per missing entry.

1. *Cancel* — `deliveryOrderRowMenu`
   (`frontend/src/pages/scm-v2/row-menus.ts`) took only
   `{open, edit, print, transferToSi, canInvoice}`, and carried a comment
   recording the omission as deliberate: the list had no cancel handler, and
   adding one "would put a stock-reversing action behind a right-click without
   the detail page's confirmation copy". The objection was to the missing
   CONFIRMATION, not to the entry — `DeliveryOrderDetailV2.tsx`'s `doCancel`
   already gated the identical write behind a `window.confirm`, and
   `MfgSalesOrdersListV2.tsx`'s `doCancelSo` already showed how a LIST does the
   same thing in-app with `useConfirm`.

2. *Transfer to Delivery Return* — the DESTINATION was never scoped.
   `CONVERT_LINKS` (`frontend/src/lib/convertScope.tsx`) had no `doToDr` pair,
   and `DeliveryReturnFromDo.tsx` imported no `useSearchParams` and no
   `readConvertScope`: it rendered `linesQ.data` whole. So the entry could not
   be added through the guaranteed path at all — `convertToLink` has no pair to
   name, and hand-writing the query is failed by
   `convertScope.test.tsx`'s tree walk. Verified rather than assumed: the
   backend half was already complete —
   `backend/src/scm/routes/delivery-returns.ts:1447-1448` register
   `POST /from-do` and `POST /from-dos` onto `convertDoLinesToReturn` (`:1226`).

**Fix.**

- `doToDr` added to `CONVERT_LINKS` (`/scm/delivery-returns/from-do?doId=`), and
  `DeliveryReturnFromDo.tsx` now reads it with `readConvertScope`, filters on
  `deliveryOrderId`, pre-ticks the scoped note's remaining lines under the
  one-customer lock, and renders `UnrecognisedScopeNotice`.
- `deliveryOrderRowMenu` gained `transferToDr` / `canReturn`, `confirm` /
  `canConfirm` and `cancel` / `canCancel`, the last as a `dangerItem` alone in
  the final group.
- `MfgDeliveryOrdersListV2.tsx` wires them: `doCancelDo` asks through
  `useConfirm` before posting the detail page's own endpoint
  (`PATCH /delivery-orders-mfg/:id/status`, `CANCELLED`); `confirm` reuses the
  drawer's existing `doAdvance`; `canReturn` is the shared
  `doCountsAsDelivered`, the same predicate the server's returnable picker
  applies.

Pinned by four new cases in
`frontend/src/pages/scm-v2/convert-scope-pickers.test.tsx`, which mount the real
picker at the real URL `convertToLink('doToDr', …)` builds. **Proved RED on the
unfixed shape:** with the scope filter reverted to `allRows`, "shows only the
scoped Delivery Order" and "pre-ticks the scoped note" both FAIL (2 failed | 2
passed); restored, 4 passed.

**Known and deliberate.** `canCancel` hides the entry on a `CANCELLED` or
`INVOICED` row only. The route's other refusal — `doHasDownstream`, which blocks
a cancel once a live Sales Invoice or Delivery Return points at the DO — is a
server-side fact no list row carries, so it reaches the operator through
`useUpdateMfgDeliveryOrderStatus`'s `onError` notice instead of through a
missing entry.

**Ref.** `feat/delivery-order-can-be-cancelled-and-returned`, 2026-08-22.
