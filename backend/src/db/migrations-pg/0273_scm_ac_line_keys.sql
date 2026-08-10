-- AutoCount LINE keys on the imported documents.
--
-- 0271 stored the AutoCount DOC number so a write-back can update the existing
-- AutoCount document instead of creating a duplicate. Editing a LINE needs the
-- same thing one level down: AcSyncService's /edit addresses a detail row by
-- AutoCount's DtlKey (`doc.EditDetail(dtlKey)`), because that is the only
-- handle the SDK exposes — the detail classes have no settable identity of
-- their own. Without it an edit APPENDS a new line instead of changing the one
-- the operator changed, which is exactly the duplicate-line class of bug this
-- migration exists to prevent.
--
-- Nullable by design: a line created in the ERP has no AutoCount counterpart
-- until the write-back creates one, and NULL is the correct "create, don't
-- update" signal for both SO and PO lines.
ALTER TABLE scm.mfg_sales_order_items ADD COLUMN IF NOT EXISTS linked_ac_dtlkey bigint;
CREATE INDEX IF NOT EXISTS mfg_so_items_linked_ac_dtlkey_idx
  ON scm.mfg_sales_order_items (linked_ac_dtlkey)
  WHERE linked_ac_dtlkey IS NOT NULL;

ALTER TABLE scm.purchase_order_items ADD COLUMN IF NOT EXISTS linked_ac_dtlkey bigint;
CREATE INDEX IF NOT EXISTS po_items_linked_ac_dtlkey_idx
  ON scm.purchase_order_items (linked_ac_dtlkey)
  WHERE linked_ac_dtlkey IS NOT NULL;
