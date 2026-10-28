-- The AutoCount RECEIPT number on a migrated goods receipt.
--
-- WHY A NEW COLUMN AND NOT THE ONE THAT IS ALREADY THERE. Migration 0276 added
-- `scm.grns.linked_ac_docno` and commented it "The AutoCount GR document this
-- row mirrors". It does not hold that. `create-migrated-documents.mjs` writes
-- the PURCHASE ORDER's AutoCount number into it, because one ERP goods receipt
-- covered one purchase order, and ten scripts have read it that way ever since
-- (check-gr-fidelity, check-truth-scope, check-over-receipt, check-migration-
-- fidelity, create-migrated-documents). Re-pointing that column at the receipt
-- would silently change what all of them measure, on go-live day.
--
-- So the receipt number gets its own column, the old one keeps its meaning, and
-- the comment on the old one is corrected to say what it actually holds.
--
-- WHAT IT UNLOCKS. `check-ac-erp-reconcile.mjs` printed "GR DATA — line and
-- money comparison NOT APPLICABLE" because the ERP had no way to say WHICH
-- AutoCount receipt a document stood for: the receipt numbers lived in an array
-- on the purchase order, so the reconcile could only test presence. With the
-- receipt number on the document itself, the pair (receipt, purchase order)
-- identifies an ERP goods receipt exactly, and the book's own lines can be
-- compared against it — which is the whole point of reshaping them.
--
-- Owner 2026-09-07: 「是 A 的，不过只是把那些需要的搬进来，不需要的不需要搬」 —
-- the ERP shows the receipts the account book actually made, with the book's own
-- dates and quantities, for the in-scope set only.
--
-- REVERSAL: ALTER TABLE scm.grns DROP COLUMN IF EXISTS linked_ac_gr_docno;
--   Nothing reads it before the reshape writer runs, and dropping it loses only
--   the receipt-number link — no quantity, no money, no document.
-- Verified against: production, 2026-09-07 (check-gr-shape run 34135520445 read
--   scm.grns and confirmed linked_ac_docno holds the purchase order's number on
--   all 320 migrated receipts).
ALTER TABLE scm.grns
  ADD COLUMN IF NOT EXISTS linked_ac_gr_docno text;

COMMENT ON COLUMN scm.grns.linked_ac_gr_docno IS
  'The AutoCount GOODS RECEIPT (GR) document this row mirrors. One AutoCount receipt can cover several purchase orders while an ERP goods receipt covers one, so several rows may share a value; the pair (linked_ac_gr_docno, purchase order) is what identifies the document. Set by reshape-migrated-grns.mjs.';

-- Correcting 0276's comment, which described an intention rather than the data.
COMMENT ON COLUMN scm.grns.linked_ac_docno IS
  'The AutoCount PURCHASE ORDER this receipt was raised against - NOT the GR number, despite what migration 0276 said. The receipt number is linked_ac_gr_docno. Reference only.';

-- Finding every ERP document that stands for one AutoCount receipt is a
-- predicate, not a scan of an array on another table.
CREATE INDEX IF NOT EXISTS grns_linked_ac_gr_docno_idx
  ON scm.grns (company_id, linked_ac_gr_docno)
  WHERE linked_ac_gr_docno IS NOT NULL;
