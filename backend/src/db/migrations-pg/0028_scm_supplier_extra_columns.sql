-- 0028_scm_supplier_extra_columns.sql — four extra master columns on
-- scm.suppliers so an AutoCount creditor export can be seeded 1:1.
--   registration_no    — company registration number (AutoCount "Reg. No.")
--   nature_of_business — free-text business nature line
--   exemption_no       — SST / tax exemption number
--   phone2             — secondary phone (E.164, normalized by the API)
-- All columns nullable, additive, idempotent — safe to re-run.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT
-- (pg-migrate owns the txn); each statement ends ';'+newline with no
-- internal ';\n'.
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS registration_no text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS nature_of_business text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS exemption_no text;
ALTER TABLE scm.suppliers ADD COLUMN IF NOT EXISTS phone2 text;
