## A partial conversion told AutoCount to transfer the WHOLE parent, moving stock in a live book that never moved here [high]

**Symptom** - a delivery order shipping 2 of a sales order's 5 lines would
produce an AutoCount DO carrying all 5. Same for a GRN receiving part of a PO, an
invoice covering part of a DO, and a purchase invoice covering part of a GRN.
Never observed live, because the write-back has never drained in production - but
partial shipment is what the business does daily, so the first drain would have
done it on the first document.

**Root cause (traced, not guessed)** - `enqueueConvert` deliberately sent no
`DtlKeys`, with a comment arguing that AutoCount's own book is the authority on
which lines are still outstanding. It is, and that is beside the point.
`AcSyncService.DtlKeys()` reads the payload first and **falls back to
`SELECT d.DtlKey ... WHERE (d.Qty - ISNULL(d.TransferedQty,0)) > 0` over the
whole parent** when the array is absent, then hands that set to
`AddPartialTransferDetail`. "Let AutoCount answer" and "transfer everything" are
the same instruction. The information to do better was already on hand: every
downstream line carries its source line (`delivery_order_items.so_item_id`,
`grn_items.purchase_order_item_id`, `sales_invoice_items.do_item_id`,
`purchase_invoice_items.grn_item_id`), and 0273 + 0280 put `linked_ac_dtlkey` on
all six line tables.

**Fix** - `readConvertSourceKeys` resolves the subset and sends it. Three
outcomes, not two: send the keys when every source line has one; **REFUSE** with
a visible `skipped` row when the transfer is a strict subset and a key is missing
(sending nothing there is precisely the defect); fall back to no `DtlKeys` only
when the document covers every line of the parent, where "all outstanding" is the
same set. A cancelled parent SO line does not count as one left behind. Six tests
pin the three branches. **Not fixed and now written down** (module doc 7b): a
partial QUANTITY on a line, which `AddPartialTransferDetail` cannot express at
all - it takes line keys, not quantities.

**Ref** - feat/writeback-all-six, 2026-08-11.
