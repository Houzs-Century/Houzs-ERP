-- 115_remove_pending_inspection.sql
-- D1 test mirror of migrations-pg/0105 — Pending Inspection retired,
-- inspection folded into Under Verification (inspection_by +
-- qc_receipt_date + new qc_issue_result). The assr_cases stage CHECK
-- (mig 074) still lists pending_inspection; that superset is harmless
-- and avoids a full-table rebuild in the mirror.

ALTER TABLE assr_cases ADD COLUMN qc_issue_result TEXT;

UPDATE assr_cases SET stage = 'under_verification' WHERE stage = 'pending_inspection';

DELETE FROM assr_stage_history WHERE stage = 'pending_inspection';
