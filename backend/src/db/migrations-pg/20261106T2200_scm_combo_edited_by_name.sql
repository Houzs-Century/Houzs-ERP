-- Combo edit history shows who made each change. created_by holds the bridged SCM id,
-- which every caller shares, so the name is stored with the row as other audit trails do.
-- REVERSAL: ALTER TABLE scm.sofa_combo_pricing DROP COLUMN IF EXISTS created_by_name;

ALTER TABLE scm.sofa_combo_pricing ADD COLUMN IF NOT EXISTS created_by_name text;

COMMENT ON COLUMN scm.sofa_combo_pricing.created_by_name IS 'Name of the person who saved this row. Null on rows from before the column and on auto-derived costs.';
