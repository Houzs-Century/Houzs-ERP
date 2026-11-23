-- 20261123T0300_scm_stock_take_line_entered_cost.sql
-- REVERSAL: ALTER TABLE scm.stock_take_lines DROP COLUMN entered_unit_cost_sen;
--
-- Let a found (positive-variance) line post when its SKU has no priced lot.
--
-- A count-up on a SKU with no cost basis is refused (cost_required): the new
-- lot would floor to RM0 and never re-cost. Until now the only fix was a
-- separate costed Stock Adjustment. This column lets the counter type the unit
-- cost on the sheet itself; Post then values the found lot from it, exactly as a
-- costed Stock Adjustment does (the FIFO trigger already reads the ADJUSTMENT
-- movement's unit_cost_sen). Nullable; only consulted for a +variance line with
-- no lot cost, and a 0 / NULL entry still refuses. No existing row is touched.

ALTER TABLE scm.stock_take_lines
  ADD COLUMN IF NOT EXISTS entered_unit_cost_sen integer;

COMMENT ON COLUMN scm.stock_take_lines.entered_unit_cost_sen IS
  'Operator-entered unit cost (sen) for a found line whose SKU has no priced lot; Post values the new lot from it instead of refusing cost_required (20261123T0300).';
