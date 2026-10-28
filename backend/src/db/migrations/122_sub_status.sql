-- D1 test mirror of migrations-pg/0116_sub_status.sql.
ALTER TABLE assr_cases ADD COLUMN sub_status TEXT;
UPDATE assr_cases SET sub_status = CASE WHEN qc_receipt_date IS NOT NULL OR COALESCE(qc_issue_result, '') != '' THEN 'qc_issue_result' ELSE 'pending_inspection' END WHERE stage = 'under_verification' AND archived_at IS NULL;
UPDATE assr_cases SET sub_status = CASE WHEN supplier_pickup_at IS NOT NULL THEN 'pending_supplier_return' ELSE 'pending_supplier_pickup' END WHERE stage = 'pending_supplier_pickup' AND archived_at IS NULL;
