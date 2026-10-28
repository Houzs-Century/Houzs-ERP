-- 0105_remove_pending_inspection.sql
-- Service-case workflow drops the standalone Pending Inspection stage
-- (mobile redesign handoff, Nick 2026-07-14). Inspection now lives
-- INSIDE Under Verification: inspection_by (own/supplier, mig 0073),
-- qc_receipt_date (mig 105) and the new qc_issue_result carry it.
--
-- Cases parked on the retired stage move to under_verification (Nick's
-- pick — "checking the issue" IS the verification phase now), and the
-- retired stage's history rows are dropped per the handoff.

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS qc_issue_result TEXT;

UPDATE assr_cases SET stage = 'under_verification' WHERE stage = 'pending_inspection';

DELETE FROM assr_stage_history WHERE stage = 'pending_inspection';
