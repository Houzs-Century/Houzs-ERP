-- 090_payment_deposit_pills.sql
--
-- Boss-requested: replace the standalone Payment panel with two
-- multi-state checklist rows that render as pills (like the old
-- EventDetail design):
--
--   PAYMENT  > Rental Payment    : NONE / UNPAID / FULLY PAID
--   CLOSEOUT > Security Deposit  : NONE / UNPAID / PAID / REFUNDED
--
-- Mechanism: two new nullable columns on the checklist (per-project +
-- template). pill_kind names the option set ('rental_payment' |
-- 'security_deposit'); pill_value holds the current choice. When
-- pill_kind is set the UI renders pills instead of the done/pending
-- circle, and the row's status is forced to 'na' so it never counts
-- toward checklist progress (payment isn't task completion).
--
-- Applied to templates (future projects) AND every existing project.
-- Idempotent: guards prevent duplicate sections/items; COALESCE keeps
-- any value a user already set.

-- ── Columns ───────────────────────────────────────────────────
ALTER TABLE project_checklist                ADD COLUMN pill_kind TEXT;
ALTER TABLE project_checklist                ADD COLUMN pill_value TEXT;
ALTER TABLE project_checklist_template_items ADD COLUMN pill_kind TEXT;
ALTER TABLE project_checklist_template_items ADD COLUMN pill_value TEXT;

-- ── PAYMENT section on templates (sort 35: after OPERATION, before CLOSEOUT)
INSERT INTO project_checklist_template_sections (template_id, name, sort_order, display_mode)
  SELECT t.template_id, 'PAYMENT', 35, 'list'
    FROM (SELECT DISTINCT template_id FROM project_checklist_template_sections WHERE template_id IN (1,2)) t
   WHERE NOT EXISTS (
     SELECT 1 FROM project_checklist_template_sections s
      WHERE s.template_id = t.template_id AND s.name = 'PAYMENT'
   );

-- ── Rental Payment template item ──────────────────────────────
INSERT INTO project_checklist_template_items
  (template_id, seq, title, description, due_offset_days, required_perm, requires_review, section_id, role_label, crew_visible, pill_kind, pill_value)
  SELECT s.template_id, 35, 'Rental Payment', NULL, NULL, NULL, 0, s.id, NULL, 0, 'rental_payment', 'unpaid'
    FROM project_checklist_template_sections s
   WHERE s.template_id IN (1,2) AND s.name = 'PAYMENT'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist_template_items i
        WHERE i.template_id = s.template_id AND i.title = 'Rental Payment'
     );

-- ── Security Deposit template item -> pill ────────────────────
UPDATE project_checklist_template_items
   SET pill_kind = 'security_deposit',
       pill_value = COALESCE(pill_value, 'unpaid')
 WHERE title = 'Security Deposit';

-- ── PAYMENT section on every existing project ─────────────────
INSERT INTO project_checklist_sections (project_id, name, sort_order, display_mode)
  SELECT p.id, 'PAYMENT', 35, 'list'
    FROM projects p
   WHERE NOT EXISTS (
     SELECT 1 FROM project_checklist_sections s
      WHERE s.project_id = p.id AND s.name = 'PAYMENT'
   );

-- ── Rental Payment row on every existing project ──────────────
INSERT INTO project_checklist
  (project_id, section_id, seq, title, description, required_perm,
   role_label, crew_visible, due_date, due_offset_days, status, pill_kind, pill_value)
  SELECT s.project_id, s.id, 35, 'Rental Payment', NULL, NULL,
         NULL, 0, NULL, NULL, 'na', 'rental_payment', 'unpaid'
    FROM project_checklist_sections s
   WHERE s.name = 'PAYMENT'
     AND NOT EXISTS (
       SELECT 1 FROM project_checklist c
        WHERE c.project_id = s.project_id AND c.title = 'Rental Payment'
     );

-- ── Security Deposit rows -> pill (excluded from progress) ─────
UPDATE project_checklist
   SET pill_kind = 'security_deposit',
       pill_value = COALESCE(pill_value, 'unpaid'),
       status = 'na',
       updated_at = datetime('now')
 WHERE title = 'Security Deposit';
