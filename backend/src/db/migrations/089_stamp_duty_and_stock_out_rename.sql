-- 089_stamp_duty_and_stock_out_rename.sql
--
-- Boss-requested checklist edits, applied to BOTH the templates
-- (future projects) and every existing project's checklist:
--
--   1. OPERATION: add 'Stamp Duty' between 'License (from Majlis)'
--      (seq 50) and 'Work / Loading Bay Permit' (seq 60) -> seq 55.
--      due_offset_days = -7, same relative deadline as License.
--   2. BOOTH LAYOUT & SETUP: rename 'Stock Transfer Record' ->
--      'Stock Out Transfer Record'.
--
-- Idempotent: re-running inserts nothing if 'Stamp Duty' already
-- exists, and the renames are no-ops once applied. Templates 1 and 2
-- are Exhibition / Solo (see mig 066).

-- ── 1a. Stamp Duty on the templates (future projects) ─────────
INSERT INTO project_checklist_template_items
  (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id, role_label, crew_visible)
  SELECT s.template_id, 55, 'Stamp Duty', NULL, -7, NULL, 0, s.id, NULL, 0
    FROM project_checklist_template_sections s
   WHERE s.template_id IN (1, 2)
     AND s.name = 'OPERATION'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist_template_items i
        WHERE i.template_id = s.template_id AND i.title = 'Stamp Duty'
     );

-- ── 1b. Stamp Duty on every existing project's checklist ──────
-- Resolved due_date = project.start_date - 7 days, mirroring the
-- clone logic (resolveDueDate) in services/projects.ts.
INSERT INTO project_checklist
  (project_id, section_id, seq, title, description, required_perm,
   role_label, crew_visible, due_date, due_offset_days, status)
  SELECT s.project_id, s.id, 55, 'Stamp Duty', NULL, NULL,
         NULL, 0,
         CASE WHEN p.start_date IS NOT NULL AND p.start_date <> ''
              THEN date(p.start_date, '-7 days') ELSE NULL END,
         -7, 'pending'
    FROM project_checklist_sections s
    JOIN projects p ON p.id = s.project_id
   WHERE s.name = 'OPERATION'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist c
        WHERE c.project_id = s.project_id AND c.title = 'Stamp Duty'
     );

-- ── 2. Rename 'Stock Transfer Record' -> 'Stock Out Transfer Record'
UPDATE project_checklist_template_items
   SET title = 'Stock Out Transfer Record'
 WHERE title = 'Stock Transfer Record';

UPDATE project_checklist
   SET title = 'Stock Out Transfer Record',
       updated_at = datetime('now')
 WHERE title = 'Stock Transfer Record';
