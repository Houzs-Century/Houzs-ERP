-- D1 test-mirror of migrations-pg/0062_assr_qc_receipt_date.sql.
-- Adds qc_receipt_date (editable "QC Issue Inspection" date on the
-- VerificationCard, distinct from the auto-stamped verified_at
-- audit timestamp).
ALTER TABLE assr_cases ADD COLUMN qc_receipt_date TEXT;
