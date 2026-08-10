-- AutoCount goods-received cross-reference on a migrated purchase order.
--
-- Owner 2026-08-10: "最重要是你要把这些 transfer / migrate 记录全部写下来，要不然
-- 以后担心他们整个系统的数据会全部乱掉."
--
-- The cutover imports purchase orders that AutoCount had ALREADY received, so
-- the ERP line carries received_qty and the header reads RECEIVED — but there is
-- no ERP goods-received document behind it, and deliberately so: the physical
-- units are already on hand from the balance snapshot, and posting a GRN for
-- them would count the same stock twice.
--
-- That leaves one honest gap: a human looking at the PO cannot tell WHICH
-- AutoCount receipt brought the goods in. These columns close it by naming the
-- source documents instead of fabricating an ERP one — the receipt stays where
-- it actually happened, and the ERP can point at it.
ALTER TABLE scm.purchase_orders
  ADD COLUMN IF NOT EXISTS linked_ac_grn_docnos text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS linked_ac_pinv_docnos text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN scm.purchase_orders.linked_ac_grn_docnos IS
  'AutoCount GR document numbers that received this PO before the cutover. Reference only: no ERP GRN exists for them and no ERP stock movement was ever posted from them (the units came in with the balance snapshot). Never post a GRN to "fix" a PO that has these - it double-counts.';
COMMENT ON COLUMN scm.purchase_orders.linked_ac_pinv_docnos IS
  'AutoCount Purchase Invoice document numbers raised from those receipts. Reference only.';
