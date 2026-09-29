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
-- Backfill: only the two system-written kinds are marked applied, because the
-- flat binding already held their price when they were recorded:
--   'supplier price snapshot' — recordSupplierPriceHistorySafe, after a direct edit
--   'Auto-baseline: ...'      — the current cost, written beside a first schedule
-- Every row an operator scheduled stays NULL, whatever its date, since none of
-- them ever reached the flat binding (a today-dated schedule did nothing either).
-- The first run applies only the row that is still live as of today, so an older
-- schedule superseded by a later direct edit is marked, not re-applied.
--
-- REVERSAL: ALTER TABLE scm.supplier_binding_price_history DROP COLUMN IF EXISTS applied_at;
-- No view, no grants to restore.

SET search_path = public, scm;

ALTER TABLE scm.supplier_binding_price_history
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

UPDATE scm.supplier_binding_price_history
   SET applied_at = created_at
 WHERE applied_at IS NULL
   AND (notes = 'supplier price snapshot' OR notes LIKE 'Auto-baseline:%');

CREATE INDEX IF NOT EXISTS idx_sbph_pending
  ON scm.supplier_binding_price_history (effective_from)
  WHERE applied_at IS NULL;
