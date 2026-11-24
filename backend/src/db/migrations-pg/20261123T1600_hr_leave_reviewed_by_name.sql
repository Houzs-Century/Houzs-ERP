-- 20261123T1600_hr_leave_reviewed_by_name.sql
-- Store the reviewer's display name on a leave request at review time, so the
-- desktop Leave page can show "Approved / Rejected by <name>" and a team
-- history. reviewed_by is a user-account id that lives in a different store than
-- this table, so the name cannot be joined back later — it is stamped on review.
-- Rows reviewed before this migration keep a null name (shown as "--").
--
-- No seed here.
--
-- REVERSAL: ALTER TABLE public.hr_leave_requests DROP COLUMN IF EXISTS reviewed_by_name;

ALTER TABLE public.hr_leave_requests ADD COLUMN IF NOT EXISTS reviewed_by_name text;
