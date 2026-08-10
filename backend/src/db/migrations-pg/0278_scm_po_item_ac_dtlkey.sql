-- The AutoCount LINE key on a migrated purchase-order line.
--
-- scm.purchase_orders.linked_ac_docno (0271) says which AutoCount DOCUMENT a
-- migrated PO came from. Nothing said which AutoCount LINE a given PO line came
-- from, although both importers had the value in their hands:
-- import-ac-so-linked-pos.mjs computes `dtlKey: Number(l.DtlKey)` at three
-- sites and its INSERT has 21 columns, none of them that one. The consequence
-- is not theoretical - the repair this migration ships with had to recover the
-- link from supplier_sku prefixes and (qty, Desc2) buckets, and could only do
-- it because the ERP happened to copy those fields verbatim.
--
-- PODTL.DtlKey is the PRIMARY KEY of AutoCount's PO detail table, and all 738
-- keys in the committed snapshots still resolve in the live AED_HOUZS book
-- (checked read-only over ODBC, 2026-08-10), so it is a durable handle.
--
-- MANY ERP LINES MAY SHARE ONE KEY, deliberately: one AutoCount sofa line is
-- one BUILD, and the ERP models it as one line per compartment. All of those
-- lines descend from that single PODTL row. Hence an index, never a unique
-- constraint.
--
-- NULL means "no AutoCount counterpart" - a line raised in the ERP itself. That
-- is also the write-back's "create, do not update" signal.
--
-- SAME COLUMN AS PR #1819's 0273_scm_ac_line_keys.sql, on purpose: that PR adds
-- linked_ac_dtlkey to BOTH scm.mfg_sales_order_items and this table for the
-- write-back /edit path, and this repair needs the PO half. Same name, same
-- type, same index name, both idempotent - whichever lands first does the work
-- and the other is a no-op. Adding a SECOND column of our own would have been
-- the real mistake.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT
-- (pg-migrate owns the txn); additive and idempotent.
ALTER TABLE scm.purchase_order_items ADD COLUMN IF NOT EXISTS linked_ac_dtlkey bigint;
CREATE INDEX IF NOT EXISTS po_items_linked_ac_dtlkey_idx
  ON scm.purchase_order_items (linked_ac_dtlkey)
  WHERE linked_ac_dtlkey IS NOT NULL;

COMMENT ON COLUMN scm.purchase_order_items.linked_ac_dtlkey IS
  'AutoCount PODTL.DtlKey this line was imported from. NOT unique: one AutoCount sofa line becomes one ERP line per compartment and every one of them carries the same key. NULL = raised in the ERP, no AutoCount counterpart.';
