## The two CONSIGNMENT return docs let an unlinked line be re-pointed at the parent's own goods by editing the code — GAP-2 edit back door [medium]

<!-- area: Delivery, DO, returns -->

**白话.** 寄售退货（consignment return）和采购寄售退货（purchase consignment return）
这两张退货单，之前可以这样钻空子：先加一条源单里没有的货（系统允许，因为那是正常的
临时/赠品行），存一次；再把这条行的货号改成源单本来就有的货，第二次存。改完之后这条行
和源单的行还是没连上（link 还是空），而所有"这批货退过没有"的核对全都是看这个 link 的，
所以同一批货可以退第二次——寄售退货是把货收回来（IN），采购寄售退货是把货送出去（OUT），
两边都会重复动库存。GRN / 采购退货 / 交货退货 / 销售发票这四张单早就堵了这个洞，就差这
两张寄售退货没堵。

**Symptom.** `PATCH /consignment-returns/:id/items/:itemId` and
`PATCH /purchase-consignment-returns/:id/items/:itemId` mapped `item_code` /
`variants` straight into the update with no guard. An operator could add a line
whose code is NOT on the parent document (correctly allowed — the ad-hoc /
goodwill carve-out), then edit that line's code to one the parent DOES carry.

**Root cause (traced).** The stored link column stays NULL through that edit
(`consignment_do_item_id` for the CN return, `pc_receive_item_id` for the PC
return), and every cap + recount on both chains is gated on that link being
non-null: the consignment-return over-return cap (`checkCrOverRemaining`, gated
on `noteItemId`) and its inventory resync, and the purchase-consignment-return
qty cap (`qtyCapRefusal` on `purchase_consignment_receive_items`, gated on
`receiveItemId`) and `adjustPcReceiveReturnedQty`. So a re-pointed unlinked line
counts against no parent line and the same goods can be returned twice. Identical
to the GRN / purchase-return / delivery-return / sales-invoice edit hole closed
2026-08-17; these two routes were added without the guard and nobody noticed —
the exact "a rule at N call sites ends up at N-1" failure the shared guard exists
to prevent.

**Fix.** Wired `unlinkedEditRefusal` (`scm/lib/unlinked-line-edit-guard.ts`) into
both line-PATCH handlers, after the qty/over-return cap and before the update,
with two new chains in its CHAINS map: `'consignment-return'` (parent = the
Consignment Note, codes from `consignment_delivery_order_items` via new
`cnItemCodesOf`) and `'purchase-consignment-return'` (parent = the PC Receive,
codes from `purchase_consignment_receive_items` via new `pcReceiveItemCodesOf`).
Same narrow rule as the other four: refused only on the transition
not-on-parent -> on-parent (409 `unlinked_line_repoint`); a genuinely ad-hoc
code, a linked line, and a code-untouched qty edit all still pass; a failed
parent read fails CLOSED (`unlinked_check_failed`). Tests added to
`unlinked-line-edit-guard.test.ts` (exploit refuse per chain, parent-from-header
resolution, ad-hoc allow, linked-qty allow, fail-closed) plus both handlers
added to the source-slice WIRING assertion.

**Ref.** refactor/txn-consignment-return-guard, 2026-08-20.
