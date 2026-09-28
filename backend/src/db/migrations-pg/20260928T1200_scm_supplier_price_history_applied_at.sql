-- 20260928T1200_scm_supplier_price_history_applied_at.sql
-- BUG-32: a supplier price scheduled with an effective date was stored in
-- scm.supplier_binding_price_history and never applied. The flat binding (what
-- a PO reads) and the derived product cost (what an SO / Sales Report reads)
-- kept the old price after the date passed.
--
-- applied_at marks a history row whose price has been copied onto the flat
-- scm.supplier_material_bindings row. The nightly job (00:05 MYT) applies every
-- row with applied_at IS NULL AND effective_from <= today, so the column is how
-- it knows which rows are still pending.
--
-- Backfill: a row whose effective_from is on or before the day it was recorded
-- was a snapshot of the flat price at the time (or an effective-today schedule),
-- so the flat binding already carried it or a later edit superseded it — mark
-- it applied. A row recorded ahead of its date was a scheduled change and stays
-- NULL, including the ones whose date has already passed: the job applies them
-- on its first run.
--
-- REVERSAL: ALTER TABLE scm.supplier_binding_price_history DROP COLUMN IF EXISTS applied_at;
-- No view, no grants to restore.

SET search_path = public, scm;

ALTER TABLE scm.supplier_binding_price_history
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

UPDATE scm.supplier_binding_price_history
   SET applied_at = created_at
 WHERE applied_at IS NULL
   AND effective_from <= (created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date;

CREATE INDEX IF NOT EXISTS idx_sbph_pending
  ON scm.supplier_binding_price_history (effective_from)
  WHERE applied_at IS NULL;
