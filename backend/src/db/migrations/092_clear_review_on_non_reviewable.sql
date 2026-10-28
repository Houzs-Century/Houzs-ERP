-- 092_clear_review_on_non_reviewable.sql
--
-- The approve/reject review workflow now applies ONLY to:
--   Agreement / Quotation, 3D Checked by MGT, 3D Approved by Peter,
--   Stock Out Transfer Record, Stock In Transfer Record.
--
-- Clear any leftover review state on every other checklist item so no
-- "In Review" / "Rejected" badge lingers with no way to act on it.
-- Idempotent.

UPDATE project_checklist
   SET review_status = NULL,
       rejection_reason = NULL,
       updated_at = datetime('now')
 WHERE review_status IS NOT NULL
   AND title NOT IN (
     'Agreement / Quotation',
     '3D Checked by MGT',
     '3D Approved by Peter',
     'Stock Out Transfer Record',
     'Stock In Transfer Record'
   );
