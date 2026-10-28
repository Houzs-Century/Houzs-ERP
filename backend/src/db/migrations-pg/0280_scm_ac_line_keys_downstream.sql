-- AutoCount LINE keys on the four DOWNSTREAM document types.
--
-- 0273 put linked_ac_dtlkey on scm.mfg_sales_order_items and
-- scm.purchase_order_items — the two document types the ERP can CREATE in
-- AutoCount. This adds the same column to the four it can only CONVERT into.
--
-- WHY THIS IS THE BLOCKER, not a nicety. AcSyncService's /edit addresses a
-- detail row by AutoCount's DtlKey (`doc.EditDetail(dtlKey)`), because that is
-- the only handle the 2.2 SDK exposes — no detail class has a settable identity
-- of its own, and AutoCount carries NO line-to-line keys between documents
-- either (PIDTL.FromDocDtlKey is populated on 0 of 20,777 rows, GRDTL on 0 of
-- 21,000). Without a stored DtlKey the ERP cannot name the line the operator
-- changed. 0273's own header states the consequence: a WRONG key makes
-- AcSyncService append a new line instead of changing the one that changed, so
-- a wrong key is strictly worse than NULL — NULL means "create".
--
-- Both sides therefore REFUSE a keyless line rather than guessing
-- (composeEdit's KeylessLineError, and AcSyncService.Edit()'s pre-flight pass).
-- That refusal is why DO / GRN / Sales Invoice / Purchase Invoice edits cannot
-- be expressed at all today: the column they would be read from does not exist,
-- so `linked_ac_dtlkey` came back undefined for every line and every edit was
-- refused. This migration is what makes the refusal a DATA question ("has this
-- document been stamped yet?") instead of a SCHEMA one ("this can never work").
--
-- Nullable by design, and NULL is the honest default for every row that exists
-- today. Nothing backfills it: the keys are stamped forward, at the moment
-- AcSyncService reports the lines it created for a conversion (persistLineKeys,
-- gated on a count + ItemCode + Desc2 match). A document created before the
-- write-back was switched on keeps NULL keys and its first edit is refused
-- LOUDLY, with a visible skipped outbox row naming the document. That is the
-- intended behaviour, not a gap to paper over.
ALTER TABLE scm.delivery_order_items   ADD COLUMN IF NOT EXISTS linked_ac_dtlkey bigint;
ALTER TABLE scm.grn_items              ADD COLUMN IF NOT EXISTS linked_ac_dtlkey bigint;
ALTER TABLE scm.sales_invoice_items    ADD COLUMN IF NOT EXISTS linked_ac_dtlkey bigint;
ALTER TABLE scm.purchase_invoice_items ADD COLUMN IF NOT EXISTS linked_ac_dtlkey bigint;

-- Partial, matching 0273: the column is NULL on almost every row, and the only
-- query that reads it looks for the rows where it is set.
CREATE INDEX IF NOT EXISTS do_items_linked_ac_dtlkey_idx
  ON scm.delivery_order_items (linked_ac_dtlkey)   WHERE linked_ac_dtlkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS grn_items_linked_ac_dtlkey_idx
  ON scm.grn_items (linked_ac_dtlkey)              WHERE linked_ac_dtlkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS si_items_linked_ac_dtlkey_idx
  ON scm.sales_invoice_items (linked_ac_dtlkey)    WHERE linked_ac_dtlkey IS NOT NULL;
CREATE INDEX IF NOT EXISTS pi_items_linked_ac_dtlkey_idx
  ON scm.purchase_invoice_items (linked_ac_dtlkey) WHERE linked_ac_dtlkey IS NOT NULL;
