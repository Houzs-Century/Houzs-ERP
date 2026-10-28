-- Editable QC-on-receipt inspection date for the "QC Issue Inspection"
-- card (VerificationCard). Separate from verified_at, which stays as
-- the server-stamped audit timestamp of when the outcome decision was
-- entered — this column is the human-picked date the QC actually
-- physically inspected the returned item at the office.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS qc_receipt_date TEXT;
