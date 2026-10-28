-- 085_checklist_role_label_and_display_mode.sql
--
-- Tasklist as the universal document/workflow primitive
-- (decided 2026-05-28).
--
-- The boss's PMS template hardcodes named document slots and PM
-- workflow groups. Our project_checklist + sections model (mig 050)
-- is already the right abstraction for all of it; we just need two
-- display knobs so the existing tasklist UI can render as nicely as
-- their hand-rolled doc table:
--
--   1. role_label — free-text owner tag rendered as a chip next to
--      each task's title (e.g. "DRIVER", "SALES PIC", "BD",
--      "PURCHASER"). Separate from required_perm, which gates *who
--      can complete the task*; this column is purely *who owns it at
--      a glance*. Lives on both the per-project rows and the
--      template they were instantiated from, so the template seeds
--      the label onto every new project.
--
--   2. display_mode on sections — 'list' (default, today's layout)
--      or 'documents' (6-column table: Document / Remarks / Files /
--      Uploaded By / Approval / Actions). Per-section so a template
--      can mix workflow lists with document tables on the same page.
--      Stored on both the per-project section and its template
--      counterpart for the same reason.

ALTER TABLE project_checklist                 ADD COLUMN role_label TEXT;
ALTER TABLE project_checklist_template_items  ADD COLUMN role_label TEXT;

ALTER TABLE project_checklist_sections          ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'list';
ALTER TABLE project_checklist_template_sections ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'list';
