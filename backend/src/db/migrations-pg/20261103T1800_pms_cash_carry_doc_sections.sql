-- 20261103T1800_pms_cash_carry_doc_sections.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Cash & Carry projects get the two DOCUMENT checklist sections that every
-- Exhibition / Solo project already has — "BOOTH LAYOUT & SETUP" and
-- "SETUP & DISMANTLE DOCUMENTS" — and nothing else. Owner request
-- (2026-11-03): a Cash & Carry booth still needs its stock-out transfer, its
-- floor-plan / 3D / 2D design, and its setup & dismantle photos tracked the
-- same way, but NOT the Contract / 3D Approval / Operation / Closeout /
-- Expo-Map sections a full exhibition carries.
--
-- The "Cash & Carry" event type (mig 20261014T1147) was created with
-- default_template_id = NULL, so services/projects.ts
-- ::instantiateChecklistFromEventType clones NOTHING on create and a new
-- Cash & Carry project opens with an empty tasklist. This gives that event
-- type its own template holding only the two document sections, then back-
-- fills the handful of Cash & Carry projects that were created before it.
--
-- WHY IT COPIES INSTEAD OF HARD-CODING THE ROWS. The live item set for those
-- two sections has drifted from any single migration (renames in 089, the
-- stock-in rework in 091, the role_label / display_mode / pill columns from
-- 085 / 086 / 090) and is edited through the Project Maintenance template
-- editor besides. So this migration copies whatever those two sections hold
-- RIGHT NOW on the template the "exhibition" event type points at — section
-- names, sort order, display_mode, and every item column (seq, title,
-- description, required_perm, role_label, crew_visible, due_offset_days,
-- requires_review, pill_kind, pill_value). The new template therefore matches
-- what an Exhibition project shows for those two sections on THIS database,
-- whatever its id or company happens to be, with no per-database editing.
--
-- company_id: the new template, its sections and items inherit the source
-- template's company_id (the owner of the Exhibition template — HOUZS on every
-- database today). The back-filled per-project rows take the project's own
-- company_id, which is stricter than the app's own clone path (it omits the
-- column and leans on the DEFAULT 1); for the existing Cash & Carry projects,
-- all HOUZS, the result is identical.
--
-- SEED STATUS matches the clone path exactly: a pill row (none here) or an
-- OPERATION-section item (neither section is OPERATION) would seed 'na'; every
-- other item seeds 'pending'. due_date = start_date + due_offset_days (date
-- only, UTC), exactly resolveDueDate(); a project with no start_date leaves
-- due_date NULL. requires_review = 1 with no explicit required_perm maps to
-- 'projects.approve', reusing the review pipeline, same as the clone path.
--
-- IDEMPOTENT + re-run-safe. The template is created only while the Cash & Carry
-- event type still has no template; the pointer is set only while it is NULL;
-- sections and items copy only when the destination section / section-items do
-- not already exist; the back-fill skips any project that already has either
-- document section, and any checklist row it already has for a cloned section.
-- Additive: no existing row on any project or template is modified or deleted.
--
-- REVERSAL: safe to undo by hand, in this order, for ONE database --
--   1. UPDATE project_event_types SET default_template_id = NULL WHERE slug = 'cash_carry';
--   2. DELETE FROM project_checklist WHERE section_id IN (SELECT id FROM project_checklist_sections WHERE name IN ('BOOTH LAYOUT & SETUP','SETUP & DISMANTLE DOCUMENTS') AND project_id IN (SELECT id FROM projects WHERE event_type_id = (SELECT id FROM project_event_types WHERE slug='cash_carry')));
--   3. DELETE FROM project_checklist_sections WHERE name IN ('BOOTH LAYOUT & SETUP','SETUP & DISMANTLE DOCUMENTS') AND project_id IN (SELECT id FROM projects WHERE event_type_id = (SELECT id FROM project_event_types WHERE slug='cash_carry'));
--   4. DELETE FROM project_checklist_template_items  WHERE template_id = <the Cash & Carry template id>;
--   5. DELETE FROM project_checklist_template_sections WHERE template_id = <the Cash & Carry template id>;
--   6. DELETE FROM project_checklist_templates WHERE id = <the Cash & Carry template id>.
--   Step 2/3 only remove the two cloned document sections — a coordinator's
--   own edits to them are lost, which is the only non-recoverable part, so
--   confirm before running a reversal on a live Cash & Carry project.
--
-- ADDITIVE + idempotent + re-run-safe. The runner splits on ';\n', so each
-- statement ends with a semicolon on its own line.

-- 1. Create the Cash & Carry template (inherits the Exhibition template's
--    company_id). Only while the event type has no template yet.
INSERT INTO project_checklist_templates (name, description, active, company_id)
SELECT 'Cash & Carry (default)',
       'Document sections for Cash & Carry booth projects: Booth Layout & Setup and Setup & Dismantle Documents.',
       1,
       src.company_id
  FROM project_checklist_templates src
 WHERE src.id = (SELECT default_template_id FROM project_event_types WHERE slug = 'exhibition')
   AND NOT EXISTS (SELECT 1 FROM project_event_types cc WHERE cc.slug = 'cash_carry' AND cc.default_template_id IS NOT NULL);

-- 2. Point the Cash & Carry event type at the template just created (newest
--    row of that name under the same company). Only while it is still NULL.
UPDATE project_event_types
   SET default_template_id = (
         SELECT t.id
           FROM project_checklist_templates t
          WHERE t.name = 'Cash & Carry (default)'
            AND t.company_id = (SELECT src.company_id
                                  FROM project_checklist_templates src
                                 WHERE src.id = (SELECT default_template_id FROM project_event_types WHERE slug = 'exhibition'))
          ORDER BY t.id DESC
          LIMIT 1)
 WHERE slug = 'cash_carry'
   AND default_template_id IS NULL
   AND (SELECT default_template_id FROM project_event_types WHERE slug = 'exhibition') IS NOT NULL;

-- 3. Copy the two document sections from the Exhibition template into it.
INSERT INTO project_checklist_template_sections (template_id, name, sort_order, display_mode, company_id)
SELECT cc.default_template_id, ss.name, ss.sort_order, ss.display_mode, ss.company_id
  FROM project_event_types cc
  JOIN project_event_types ex ON ex.slug = 'exhibition'
  JOIN project_checklist_template_sections ss ON ss.template_id = ex.default_template_id
 WHERE cc.slug = 'cash_carry'
   AND cc.default_template_id IS NOT NULL
   AND ss.name IN ('BOOTH LAYOUT & SETUP', 'SETUP & DISMANTLE DOCUMENTS')
   AND NOT EXISTS (SELECT 1 FROM project_checklist_template_sections ns
                    WHERE ns.template_id = cc.default_template_id AND ns.name = ss.name);

-- 4. Copy those sections' items, mapping each item to the new section by name.
INSERT INTO project_checklist_template_items
       (template_id, seq, title, description, required_perm, role_label, crew_visible,
        due_offset_days, requires_review, pill_kind, pill_value, section_id, company_id)
SELECT cc.default_template_id, si.seq, si.title, si.description, si.required_perm,
       si.role_label, si.crew_visible, si.due_offset_days, si.requires_review,
       si.pill_kind, si.pill_value, ns.id, si.company_id
  FROM project_event_types cc
  JOIN project_event_types ex ON ex.slug = 'exhibition'
  JOIN project_checklist_template_sections ss
       ON ss.template_id = ex.default_template_id
      AND ss.name IN ('BOOTH LAYOUT & SETUP', 'SETUP & DISMANTLE DOCUMENTS')
  JOIN project_checklist_template_items si ON si.section_id = ss.id
  JOIN project_checklist_template_sections ns
       ON ns.template_id = cc.default_template_id AND ns.name = ss.name
 WHERE cc.slug = 'cash_carry'
   AND cc.default_template_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM project_checklist_template_items ni
                    WHERE ni.template_id = cc.default_template_id AND ni.section_id = ns.id);

-- 5. Back-fill existing Cash & Carry projects: clone the two sections into any
--    such project that does not already have them.
INSERT INTO project_checklist_sections (project_id, name, sort_order, display_mode, company_id)
SELECT p.id, ts.name, ts.sort_order, ts.display_mode, p.company_id
  FROM projects p
  JOIN project_event_types cc ON cc.id = p.event_type_id AND cc.slug = 'cash_carry'
  JOIN project_checklist_template_sections ts ON ts.template_id = cc.default_template_id
 WHERE cc.default_template_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM project_checklist_sections es
                    WHERE es.project_id = p.id AND es.name = ts.name);

-- 6. Back-fill the items for those cloned sections, matching the clone path's
--    status seeding, due-date resolution and review-perm mapping.
INSERT INTO project_checklist
       (project_id, section_id, seq, title, description, required_perm, role_label,
        crew_visible, due_date, due_offset_days, status, pill_kind, pill_value, company_id)
SELECT p.id, ps.id, ti.seq, ti.title, ti.description,
       COALESCE(ti.required_perm, CASE WHEN ti.requires_review = 1 THEN 'projects.approve' END),
       ti.role_label, ti.crew_visible,
       CASE WHEN p.start_date IS NOT NULL AND ti.due_offset_days IS NOT NULL
            THEN (p.start_date::date + ti.due_offset_days::int)::text END,
       ti.due_offset_days,
       CASE WHEN ti.pill_kind IS NOT NULL THEN 'na' ELSE 'pending' END,
       ti.pill_kind, ti.pill_value, p.company_id
  FROM projects p
  JOIN project_event_types cc ON cc.id = p.event_type_id AND cc.slug = 'cash_carry'
  JOIN project_checklist_template_sections ts ON ts.template_id = cc.default_template_id
  JOIN project_checklist_template_items ti ON ti.section_id = ts.id
  JOIN project_checklist_sections ps ON ps.project_id = p.id AND ps.name = ts.name
 WHERE cc.default_template_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM project_checklist ec
                    WHERE ec.project_id = p.id AND ec.section_id = ps.id AND ec.seq = ti.seq);
