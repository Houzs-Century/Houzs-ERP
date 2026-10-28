-- 054_checklist_due_offset.sql
--
-- Per-task due_offset_days on project_checklist so we can re-derive
-- due_date = project.start_date + offset whenever the project's
-- start_date moves. Replaces the old "shift due_dates by delta"
-- approach so the source of truth stays the offset configured in
-- Project Maintenance (template_items.due_offset_days).
--
-- Backfill: for every existing task that has a due_date AND its
-- project has a start_date, compute the offset as the day-difference
-- so currently-deployed projects keep their relative schedule
-- after the first start_date edit. Tasks without due_date stay null.

ALTER TABLE project_checklist
  ADD COLUMN due_offset_days INTEGER;

UPDATE project_checklist
   SET due_offset_days = CAST(
         julianday(due_date) -
         julianday((SELECT start_date FROM projects WHERE id = project_checklist.project_id))
         AS INTEGER
       )
 WHERE due_date IS NOT NULL
   AND (SELECT start_date FROM projects WHERE id = project_checklist.project_id) IS NOT NULL;
