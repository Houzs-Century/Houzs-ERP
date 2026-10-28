-- 050_tasklist_sections_and_attachments.sql
--
-- Tasklist rework. The project "Checklist" becomes a "Tasklist" in the
-- UI; the data model gains:
--
--   1) Sections (per-project + on the template) so tasks group into
--      stages like "Pre-event / Setup / Live / Teardown / Closed".
--      Section completion replaces the old percentage progress bar
--      with a stage-chip row.
--
--   2) `requires_review` flag on template items. Admins set this in
--      Project Maintenance; on project create it translates to
--      `required_perm = 'projects.approve'` on the cloned task, hooking
--      into the existing review pipeline (review_status / approve flow
--      from migration 024).
--
--   3) Per-task attachments — replaces the now-redundant project-level
--      "Attachments" panel. Old project_attachments rows stay intact;
--      the panel just disappears from the UI.
--
-- Idempotent. Migrations are immutable (see Decisions): if anything
-- here turns out wrong, fix forward in a new file.

-- ── 1. Sections (per-project) ──────────────────────────────
CREATE TABLE IF NOT EXISTS project_checklist_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pcs_project
  ON project_checklist_sections(project_id, sort_order);

-- Tasks reference a section. Nullable: pre-existing tasks land in
-- "Uncategorised" until an admin sorts them. ON DELETE SET NULL so
-- removing a section moves its tasks to Uncategorised rather than
-- nuking work.
ALTER TABLE project_checklist
  ADD COLUMN section_id INTEGER
  REFERENCES project_checklist_sections(id) ON DELETE SET NULL;

-- ── 2. Sections (template side) ────────────────────────────
CREATE TABLE IF NOT EXISTS project_checklist_template_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (template_id) REFERENCES project_checklist_templates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pcts_template
  ON project_checklist_template_sections(template_id, sort_order);

ALTER TABLE project_checklist_template_items
  ADD COLUMN section_id INTEGER
  REFERENCES project_checklist_template_sections(id) ON DELETE SET NULL;

-- ── 3. Requires-review flag (template side) ────────────────
-- Boolean (0/1). On project create, template items where this is 1
-- get `required_perm = 'projects.approve'` on the cloned task,
-- triggering the existing review pipeline.
ALTER TABLE project_checklist_template_items
  ADD COLUMN requires_review INTEGER NOT NULL DEFAULT 0;

-- ── 4. Per-task attachments ────────────────────────────────
-- Files live in R2; this table indexes them by task. Deletes cascade
-- when the task is deleted.
CREATE TABLE IF NOT EXISTS project_checklist_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    INTEGER,
  uploaded_by   INTEGER,
  uploaded_at   TEXT DEFAULT (datetime('now')),
  archived_at   TEXT,
  FOREIGN KEY (item_id) REFERENCES project_checklist(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pcatt_item
  ON project_checklist_attachments(item_id, archived_at);
