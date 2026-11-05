-- 173_remove_event_complete_image.sql
--
-- Owner-requested checklist edit: remove 'Event Complete Image' from the PM
-- workflow templates AND from every existing project (the Sales-PIC photo doc
-- seeded by mig 066 into SETUP & DISMANTLE DOCUMENTS).
--
-- Same shape as 091's 'Stocks Request Listing' removal: clear attachment/comment
-- rows first (FKs are ON DELETE CASCADE, but D1 doesn't always enforce the
-- pragma, so we clean them explicitly). Orphaned R2 blobs for those attachments
-- are left in the bucket — harmless, out of scope. Idempotent: delete-by-title
-- is naturally a no-op once gone.

DELETE FROM project_checklist_attachments
 WHERE item_id IN (SELECT id FROM project_checklist WHERE title = 'Event Complete Image');
DELETE FROM project_checklist_comments
 WHERE item_id IN (SELECT id FROM project_checklist WHERE title = 'Event Complete Image');
DELETE FROM project_checklist
 WHERE title = 'Event Complete Image';
DELETE FROM project_checklist_template_items
 WHERE title = 'Event Complete Image';
