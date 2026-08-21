## A return raised from the purchase order was uncapped, unlinked, and hit the wrong warehouse [high]

<!-- area: Purchase orders + GRN + PI -->

**白话.** PO 详情的「Raise Return」预填的是 PO 自己的行、不带收货行链接——每一行
都成了「手工行」：退货数量无上限、不回写收货行的 returned_qty（PO 保持全收而货
已出门）、出库落到公司**默认仓**而不是实际收货仓。三件事同时发生。修法＝换数据
源：PO 模式的预填改从「这张 PO 已过账收货单里还有可退余量的行」取（新端点
returnable-grn-lines），每行带 grnItemId——上限、消耗、正确仓全部自动归位；一张
没收过货的 PO 则明说「没有可退的收货行」，而不是给一张空白自由表单。

**Symptom.** 2026-08-21 full-flow source audit, item B6 — traced from
`PurchaseReturnNew.tsx`'s `?poId=` prefill (`grnItemId: null` on every line)
through the create handler's manual-line semantics (no cap without a link, no
`adjustGrnReturnedQty`, `resolvePrLineWarehouses` falling through to
`defaultWarehouseId`).

**Root cause (traced).** The prefill's data source was the PO's own lines,
which carry no receipt identity — and the whole guard stack keys on
`grn_item_id`. "Return of received goods" and "free-form return" are different
documents; the PO button produced the second while reading like the first.

**Fix.** Backend: `GET /purchase-returns/returnable-grn-lines?poId=` —
company-scoped POSTED GRNs of the PO, lines with remaining
(accepted − returned) > 0, errors bound; registered before `/:id` so the
literal path resolves. Frontend: the PO prefill consumes it, producing fully
linked lines (supplier from the receipts, price from the receipt line); an
empty pool renders a named notice — receive first, or go through the Goods
Receipt — instead of a blank free-form. `backend/tests/purchaseReturnFromPoLinked.test.ts`
pins route order, the POSTED/company/remaining predicates, the linked prefill,
and the absence of the null-linkage shape; RED on the unfixed tree (the
endpoint and the linked prefill do not exist there), GREEN here.

**Ref.** fix/pr-from-po-linked, 2026-08-21.
