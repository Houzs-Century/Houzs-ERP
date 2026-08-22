## The SO→PO hop lost the category, so received sofa stock was invisible to every sofa order [critical]

<!-- area: Inventory, costing, FIFO -->

**白话.** 收了货、库存有、金额对 —— 但**任何一张沙发订单都拿不到这批货**，画面还说
「Dead stock candidate（没人认领的呆滞库存）」。

原因是一条链：销售单转采购单的时候，**行的类别掉了**。类别不是装饰品，它决定货放进
哪一个库存格子 —— 系统只有在类别是沙发／床架的时候才会把布色、座位尺寸、脚高组进
那把钥匙。类别一空，钥匙就变空的，货进了「没分类」那一格。出货的时候系统拿沙发的
钥匙去找，那一格里什么都没有。

老板问「我的 SKU 都选了 sofa 可是出来 others？」—— SKU 没错，**空的类别在画面上会
被画成 OTHERS**，那只是找不到对应颜色时的备用徽章。

**Symptom.** Reproduced end-to-end on production 2026-08-22, walking the real
UI: `HC-SO-2608-004` (2 sofa lines, PC151-12 / seat 30) → `HC-PO-2608-003` →
`HC-GRN-2608-003` (posted, "inventory + PO received qty updated").

- Inventory: **stock 1, available 0**, `SCHEDULED −1`, the variant row reading
  **"Standard"**, banner **"Dead-stock candidate"**.
- Creating the DO: *"At BALAKONG WAREHOUSE: need 1, available 0 (short 1)"* for
  a receipt made minutes earlier into that same warehouse.

This is the owner's 2026-08-21 question — 「然后我不是收货了吗？为什么是show PO
outstanding？」 — in its second, worse form. An earlier hypothesis blamed
`batch_no`; a second blamed `purchase_order_items.received_qty`. Both were wrong.
`received_qty` DID roll up. The stock is simply in a bucket nothing looks in.

**Root cause (traced).**

1. `PurchaseOrderNew.tsx` `applyFromSo` mapped the picked line with
   `category: categoryForCode(p.itemCode)` — a lookup in the LOADED SKU list —
   **discarding `OutstandingSoItem.itemGroup`, the SO line's stored
   `item_group`, which the picker itself renders as the row's Category chip.**
   A code that list does not hold returns `undefined`.
2. `mfg-purchase-orders.ts` stored `item_group: it.itemGroup ?? null` — the
   server trusted the client completely and never asked the product.
3. `grns.ts:1897` copies the PO line's `item_group` onto the GRN line. Correct
   behaviour; it faithfully copies a null.
4. `computeVariantKey(item_group, variants)` composes fabric / seat / leg
   **only** for a sofa or bedframe group — for null or `others` it returns `''`
   by design (`shared/variant-key.ts`, "Accessory / Others / Service — product
   code only").
5. `postGrnAndRollup` writes the inventory movement with that empty key
   (`grns.ts:553`). The goods land in the unclassified bucket.
6. Every consumer — the DO stock check, the allocator, the dead-stock flag —
   looks up `fabriccode=…|seatheight=…|legheight=…` and finds nothing.

**Every other conversion picker in the repo already carries the group through.**
The mobile convert wizard has a test that says so by name
(`mobileConvertWizardVariants.test.tsx`: *"proves the wizard passes the real
item_group through rather than guessing"*). SO→PO was the only hop that guessed.

**Fix — both layers, because fixing only the browser leaves the next client free
to lose it again.**

- `PurchaseOrderNew.applyFromSo` uses the pick's own `itemGroup`, falling back to
  the SKU lookup.
- `mfg-purchase-orders.ts` resolves the category **from `mfg_products.category`
  by item code**, company-scoped (`code` is shared between the two
  organisations — the reason `grns.ts:287` gives), and uses it in preference to
  whatever the caller sent. Owner 2026-08-22: 「正常来说就跟着 PO 里面的 SKU 啊，
  我的 SKU 也绑定跟 category 了啊」. `description2` is built from the SAME
  resolved group, so the printed text and the stock key can never describe
  different things.

**Guard.** `frontend/src/pages/scm-v2/poFromSoKeepsCategory.test.ts` — 7 cases.
It pins the mapper's decision AND, importing the REAL `computeVariantKey`, the
consequence: a sofa group composes the fabric into the key, a lost group returns
`''`, and the two can never match. Proved RED by restoring the derivation: 2
failed.

**Still open, deliberately not in this PR.** The receipts already posted carry
the empty key; existing stock is NOT migrated by this change, and
`HC-GRN-2608-003`'s two units are still in the unclassified bucket. A backfill
needs the owner's decision (re-key in place, or a stock adjustment pair) and its
own measurement of how many rows are affected. `SCHEDULED −1` — a negative
scheduled figure on a free unit — is a separate defect surfaced by the same
screenshot and is not diagnosed here.
