-- D1 / test-tree twin of migrations-pg/20261103T1800_pms_cash_carry_doc_sections.sql.
-- The prod tree is Postgres; this SQLite copy exists so the generated test
-- schema carries the Cash & Carry checklist template that the project clone
-- path (services/projects.ts::instantiateChecklistFromEventType) reads.
--
-- Gives the "Cash & Carry" event type (mig 164, created with
-- default_template_id = NULL) a template holding ONLY the two document
-- sections — "BOOTH LAYOUT & SETUP" and "SETUP & DISMANTLE DOCUMENTS" —
-- copied from whatever the "exhibition" event type points at, so the two stay
-- in step as that template is edited. SQLite types; the template tables carry
-- no company_id here (that column is Postgres-only, migs 0093 / 0292).
--
-- No back-fill: the test tree starts empty, so there are no existing Cash &
-- Carry projects to clone into (the prod migration back-fills live ones).
-- Idempotent: the template is created only while the event type has none, the
-- pointer is set only while NULL, and sections / items copy only when absent.

-- 1. Create the Cash & Carry template.
INSERT INTO project_checklist_templates (name, description, active)
SELECT 'Cash & Carry (default)',
       'Document sections for Cash & Carry booth projects: Booth Layout & Setup and Setup & Dismantle Documents.',
       1
WHERE EXISTS (SELECT 1 FROM project_event_types WHERE slug = 'exhibition' AND default_template_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM project_event_types WHERE slug = 'cash_carry' AND default_template_id IS NOT NULL);

-- 2. Point the Cash & Carry event type at it.
UPDATE project_event_types
   SET default_template_id = (SELECT id FROM project_checklist_templates WHERE name = 'Cash & Carry (default)' ORDER BY id DESC LIMIT 1)
 WHERE slug = 'cash_carry'
   AND default_template_id IS NULL
   AND EXISTS (SELECT 1 FROM project_checklist_templates WHERE name = 'Cash & Carry (default)');

-- 3. Copy the two document sections from the Exhibition template.
INSERT INTO project_checklist_template_sections (template_id, name, sort_order, display_mode)
SELECT cc.default_template_id, ss.name, ss.sort_order, ss.display_mode
  FROM project_event_types cc
  JOIN project_event_types ex ON ex.slug = 'exhibition'
  JOIN project_checklist_template_sections ss ON ss.template_id = ex.default_template_id
 WHERE cc.slug = 'cash_carry' AND cc.default_template_id IS NOT NULL
   AND ss.name IN ('BOOTH LAYOUT & SETUP', 'SETUP & DISMANTLE DOCUMENTS')
   AND NOT EXISTS (SELECT 1 FROM project_checklist_template_sections ns WHERE ns.template_id = cc.default_template_id AND ns.name = ss.name);

-- 4. Copy those sections' items, mapping each to the new section by name.
INSERT INTO project_checklist_template_items
       (template_id, seq, title, description, required_perm, role_label, crew_visible,
        due_offset_days, requires_review, pill_kind, pill_value, section_id)
SELECT cc.default_template_id, si.seq, si.title, si.description, si.required_perm,
       si.role_label, si.crew_visible, si.due_offset_days, si.requires_review,
       si.pill_kind, si.pill_value, ns.id
  FROM project_event_types cc
  JOIN project_event_types ex ON ex.slug = 'exhibition'
  JOIN project_checklist_template_sections ss
       ON ss.template_id = ex.default_template_id
      AND ss.name IN ('BOOTH LAYOUT & SETUP', 'SETUP & DISMANTLE DOCUMENTS')
  JOIN project_checklist_template_items si ON si.section_id = ss.id
  JOIN project_checklist_template_sections ns ON ns.template_id = cc.default_template_id AND ns.name = ss.name
 WHERE cc.slug = 'cash_carry' AND cc.default_template_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM project_checklist_template_items ni WHERE ni.template_id = cc.default_template_id AND ni.section_id = ns.id);
