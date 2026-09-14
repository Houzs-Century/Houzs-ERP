-- 20260914T1700_scm_so_audit_log_payment_id.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.idx_mfg_so_audit_log_payment;
--   ALTER TABLE scm.mfg_so_audit_log DROP COLUMN IF EXISTS payment_id; — the
--   column is new and nullable, nothing existing is altered or backfilled. Rows
--   written while it existed keep every other column; they simply stop naming
--   the payment, and the report falls back to the order's own ADD_PAYMENT rows
--   for them, as it does for every older row. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NULLABLE COLUMN on scm.mfg_so_audit_log, and a partial index on it. No
-- row changes. deploy.yml applies pending migrations BEFORE the new Worker
-- deploys, so the column exists by the time the audit writer names it; a
-- Worker from before this change never writes the column and reads nothing
-- off it. Every existing row reads NULL — "written before payments were
-- tagged", which is what every row is today.
--
-- WHY IT EXISTS (docs/bugs/0888). The audit log records ADD_PAYMENT,
-- UPDATE_PAYMENT and DELETE_PAYMENT rows against the ORDER (so_doc_no) with
-- no reference to the payment row they concern, so the Corrections report
-- could not answer the owner's question about a correction — 我就是要看原本
-- 是谁记录这一笔的, who first recorded the payment that was changed — except
-- by guessing among the order's adds. Every payment action now carries the
-- payment's id here: the add, the edit, the delete, the proof attach, and the
-- two deposit rows SO create books. The report follows the id to the ADD row
-- (its actor), or to the payment row's collector for a scan-born payment whose
-- ADD row names nobody.

SET search_path = public, scm;

ALTER TABLE scm.mfg_so_audit_log ADD COLUMN IF NOT EXISTS payment_id uuid;

-- The read the report makes: the ADD_PAYMENT rows of THESE payments.
CREATE INDEX IF NOT EXISTS idx_mfg_so_audit_log_payment
  ON scm.mfg_so_audit_log (company_id, payment_id)
  WHERE payment_id IS NOT NULL;
