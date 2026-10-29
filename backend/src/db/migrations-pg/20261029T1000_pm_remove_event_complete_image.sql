-- 20261029T1000_pm_remove_event_complete_image.sql
-- IRREVERSIBLE — deletes the 'Event Complete Image' checklist rows, their
--   uploaded-photo attachment rows, and the two template items. The rows and
--   their captions are gone for good; the orphaned R2 photo blobs are left in
--   the bucket (harmless, out of scope). Revert the code first (the mobile
--   tiles and the 'Event Complete' tracker step were removed in the same PR).
--
-- WHAT THIS CHANGES: data only, no schema. Measured on production
-- (anogrigyjbduyzclzjgn) 2026-10-29:
--   project_checklist_template_items    2 rows (templates 1 & 2)
--   project_checklist                 492 rows (across 956 projects; 21 done)
--   project_checklist_attachments      27 rows (uploaded event-complete photos)
-- Attachment rows are cleared first (no ON DELETE CASCADE to project_checklist
-- in prod), then the checklist rows, then the template items. There is no
-- project_checklist_comments table in production, so none is touched (unlike
-- the D1 test removal). Idempotent: delete-by-title is a no-op once gone.
--
-- WHY (owner 2026-10-29): remove the 'Event Complete Image' task from the PM
-- workflow entirely — off the templates so new projects never get it, and off
-- every existing project. Mirrors the D1 removal in
-- backend/src/db/migrations/173_remove_event_complete_image.sql that keeps the
-- test schema in sync.

DELETE FROM project_checklist_attachments
 WHERE item_id IN (SELECT id FROM project_checklist WHERE title = 'Event Complete Image');
DELETE FROM project_checklist
 WHERE title = 'Event Complete Image';
DELETE FROM project_checklist_template_items
 WHERE title = 'Event Complete Image';
