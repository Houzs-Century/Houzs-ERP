-- 091_remove_stocks_request_add_stock_in.sql
--
-- Boss-requested checklist edits (templates + every existing project):
--
--   #7 BOOTH LAYOUT & SETUP: remove 'Stocks Request Listing'.
--   #8 SETUP & DISMANTLE DOCUMENTS: add 'Stock In Transfer Record'
--      right after 'Dismantle Image (Driver)' (seq 180 -> 185),
--      due_offset +2 (return to warehouse after dismantle).
--
-- Attachment/comment rows for the removed items are deleted first
-- (FKs are ON DELETE CASCADE, but D1 doesn't always enforce the
-- pragma, so we clean them explicitly). Orphaned R2 blobs for those
-- attachments are left in the bucket — harmless, out of scope.
-- Idempotent: guarded inserts, delete-by-title is naturally a no-op
-- once gone.

-- ── #7 Remove 'Stocks Request Listing' ────────────────────────
DELETE FROM project_checklist_attachments
 WHERE item_id IN (SELECT id FROM project_checklist WHERE title = 'Stocks Request Listing');
DELETE FROM project_checklist_comments
 WHERE item_id IN (SELECT id FROM project_checklist WHERE title = 'Stocks Request Listing');
DELETE FROM project_checklist
 WHERE title = 'Stocks Request Listing';
DELETE FROM project_checklist_template_items
 WHERE title = 'Stocks Request Listing';

-- ── #8 Add 'Stock In Transfer Record' on the templates ────────
INSERT INTO project_checklist_template_items
  (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id, role_label, crew_visible)
  SELECT s.template_id, 185, 'Stock In Transfer Record', NULL, 2, NULL, 0, s.id, NULL, 0
    FROM project_checklist_template_sections s
   WHERE s.template_id IN (1,2) AND s.name = 'SETUP & DISMANTLE DOCUMENTS'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist_template_items i
        WHERE i.template_id = s.template_id AND i.title = 'Stock In Transfer Record'
     );

-- ── #8 Add 'Stock In Transfer Record' on every existing project
INSERT INTO project_checklist
  (project_id, section_id, seq, title, description, required_perm,
   role_label, crew_visible, due_date, due_offset_days, status)
  SELECT s.project_id, s.id, 185, 'Stock In Transfer Record', NULL, NULL,
         NULL, 0,
         CASE WHEN p.start_date IS NOT NULL AND p.start_date <> ''
              THEN date(p.start_date, '+2 days') ELSE NULL END,
         2, 'pending'
    FROM project_checklist_sections s
    JOIN projects p ON p.id = s.project_id
   WHERE s.name = 'SETUP & DISMANTLE DOCUMENTS'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist c
        WHERE c.project_id = s.project_id AND c.title = 'Stock In Transfer Record'
     );
