-- 086_checklist_crew_visible.sql
--
-- Driver-visible tasklist documents (decided 2026-05-28).
--
-- Drivers + helpers can't see any of the project's tasklist today —
-- the Driver App's project page surfaces basics + crew + phase photos
-- only. But booth layouts, work permits, and floorplans now live as
-- tasklist rows (mig 085 collapsed all "document slots" into tasks),
-- which means crew has no way to pull them up on the day.
--
-- Per-task crew_visible flag. Admin opts in row by row in Project
-- Maintenance (template) or per-project (overrides). Read-only on
-- the driver side — they tap to download the attachment, nothing
-- else. Default 0 → opt-in only; nothing leaks.

ALTER TABLE project_checklist                ADD COLUMN crew_visible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_checklist_template_items ADD COLUMN crew_visible INTEGER NOT NULL DEFAULT 0;
