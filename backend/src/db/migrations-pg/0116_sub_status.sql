-- Switchable sub-status (小类) inside two stages (Nick 2026-07-15: the
-- derived version wasn't controllable — ops must switch it directly,
-- like the stage dropdown):
--   under_verification:      pending_inspection | qc_issue_result
--   pending_supplier_pickup: pending_supplier_pickup | pending_supplier_return
-- NULL on stages without sub-states. Entering a sub-status stage seeds
-- the first value (transitionStage); the backfill below seeds in-flight
-- cases from the fields the retired derived version read.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS sub_status text;
UPDATE assr_cases SET sub_status = CASE WHEN qc_receipt_date IS NOT NULL OR COALESCE(qc_issue_result, '') != '' THEN 'qc_issue_result' ELSE 'pending_inspection' END WHERE stage = 'under_verification' AND archived_at IS NULL;
UPDATE assr_cases SET sub_status = CASE WHEN supplier_pickup_at IS NOT NULL THEN 'pending_supplier_return' ELSE 'pending_supplier_pickup' END WHERE stage = 'pending_supplier_pickup' AND archived_at IS NULL;
