-- 021_projects.sql
-- Project management module — exhibitions, solo events, and any other
-- date-bound operation with a checklist, attachments, and linked logistics.
--
-- Design choices vs the origin Google Sheet:
--   • YEAR/MONTH/DURATION are derived from dates, not stored
--   • STATUS + PROGRESS replaced with lifecycle stage + computed
--     progress (% of non-NA checklist items done)
--   • Every approval/boolean column from the sheet (3D check, license,
--     permit, deposit refund…) is a row in project_checklist, so steps
--     can be added/removed per project without a migration each time
--   • Finance is split into its own table (project_finance) because
--     header edits and finance edits have different audit cadences

-- ── Lookup: event types ───────────────────────────────────────
-- Fixed catalog for now (SOLO, EXHIBITION). Each type points at a
-- default checklist template so new projects get pre-loaded tasks.

CREATE TABLE IF NOT EXISTS project_event_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,             -- 'solo' | 'exhibition'
  name TEXT NOT NULL,                    -- display label
  default_template_id INTEGER,           -- → project_checklist_templates.id
  sort_order INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ── Lookup: checklist templates ───────────────────────────────
-- A template is a named set of items that can be attached to an
-- event type or picked ad-hoc when creating a project. Items are
-- cloned into project_checklist at project creation time; editing
-- the template afterwards does NOT retro-apply to existing projects.

CREATE TABLE IF NOT EXISTS project_checklist_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_checklist_template_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,                  -- display order
  title TEXT NOT NULL,
  description TEXT,
  -- Optional permission key required to mark this item done.
  -- e.g. 'projects.approve' gates the "3D approved" step so only
  -- users with that permission can tick it. Null = anyone on the team.
  required_perm TEXT,
  -- Due date expressed as days offset from project start_date.
  -- Negative = before event (e.g. -21 for floorplan sent).
  -- Positive = after event (e.g. +7 for sales report).
  -- Null = no implicit due date.
  due_offset_days INTEGER,
  FOREIGN KEY (template_id) REFERENCES project_checklist_templates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pcti_template ON project_checklist_template_items(template_id, seq);

-- ── Core: projects ────────────────────────────────────────────
-- One row per event. Stage drives calendar colors + which actions
-- show up in the detail panel.

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,                      -- 'AKEMI-2026-001' (auto-generated on create)
  name TEXT NOT NULL,                    -- human title, e.g. "PIKOM PC Fair 2026"
  -- Lifecycle. Checked at the DB layer so bad inputs fail loud.
  stage TEXT NOT NULL DEFAULT 'draft'
    CHECK (stage IN ('draft','planning','build','live','teardown','closed','cancelled')),
  -- Dates
  start_date TEXT,                       -- ISO date (YYYY-MM-DD)
  end_date TEXT,
  -- Venue
  organizer TEXT,
  state TEXT,
  venue TEXT,
  venue_address TEXT,
  -- Brand + type
  brand TEXT
    CHECK (brand IS NULL OR brand IN ('AKEMI','ZANOTTI','DUNLOPILLO','ERGOTEX','MY SOFA FACTORY','AKEMI C&C')),
  event_type_id INTEGER,                 -- → project_event_types.id
  -- Booth
  contractor_id INTEGER,                 -- → suppliers.id (reuse supplier master for contractors)
  booth_no TEXT,
  size_sqm REAL,
  -- External references
  notion_url TEXT,
  notes TEXT,
  -- Audit
  created_by INTEGER,                    -- users.id
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  archived_by INTEGER,
  FOREIGN KEY (event_type_id) REFERENCES project_event_types(id) ON DELETE SET NULL,
  FOREIGN KEY (contractor_id) REFERENCES suppliers(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_brand ON projects(brand);
CREATE INDEX IF NOT EXISTS idx_projects_start ON projects(start_date);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived_at);

-- ── Finance (1:1) ─────────────────────────────────────────────
-- Split from projects so finance edits don't churn the header row.
-- All amounts in RM. Computed fields (net_cost, profit, margin) are
-- derived on read — don't store them.

CREATE TABLE IF NOT EXISTS project_finance (
  project_id INTEGER PRIMARY KEY,
  rental REAL,
  contractor_cost REAL,
  license_fee REAL,
  deposit_paid REAL,
  deposit_refund REAL,
  misc_cost REAL,
  total_sales REAL,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  updated_by INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ── Checklist (per project) ───────────────────────────────────
-- Cloned from the template on project creation, then fully editable.

CREATE TABLE IF NOT EXISTS project_checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  required_perm TEXT,                    -- same semantics as template
  due_date TEXT,                         -- resolved date (YYYY-MM-DD)
  owner_user_id INTEGER,                 -- users.id (assignee)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','done','na','blocked')),
  evidence_r2_key TEXT,                  -- optional file evidence (e.g. permit PDF)
  completed_by INTEGER,                  -- users.id who marked done
  completed_at TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pc_project ON project_checklist(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_pc_owner ON project_checklist(owner_user_id, status);
CREATE INDEX IF NOT EXISTS idx_pc_due ON project_checklist(due_date);

-- ── Attachments ───────────────────────────────────────────────
-- R2-backed, same pattern as assr_attachments.

CREATE TABLE IF NOT EXISTS project_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  -- Soft category so the UI can group/filter. Not strictly enumerated —
  -- keep flexible ('floorplan' | 'render_3d' | 'contract' | 'permit' | 'photo' | 'other').
  category TEXT,
  r2_key TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pa_project ON project_attachments(project_id, category);

-- ── Activity log ──────────────────────────────────────────────
-- Mirrors assr_activity. Captures stage transitions, checklist
-- completions, finance edits, assignments.

CREATE TABLE IF NOT EXISTS project_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  action TEXT NOT NULL,                  -- 'stage_change' | 'checklist_done' | 'finance_edit' | ...
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pact_project ON project_activity(project_id, created_at);

-- ── Team (per-project assignments) ────────────────────────────
-- Designers, on-site staff, sales leads. role is freeform so you can
-- introduce new hats without a schema change.

CREATE TABLE IF NOT EXISTS project_team (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT,                             -- 'designer' | 'manager' | 'sales' | 'onsite' | ...
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_ptm_user ON project_team(user_id);
CREATE INDEX IF NOT EXISTS idx_ptm_project ON project_team(project_id);

-- ── Link trips → projects ─────────────────────────────────────
-- Makes "build-day trip to KLCC" and "teardown trip back" discoverable
-- from the project and vice-versa.

ALTER TABLE trips ADD COLUMN project_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_trips_project ON trips(project_id);

-- ── Seeds: event types + starter checklist templates ──────────
-- Two starter templates — deliberately minimal. User will customize
-- per project; this is just a useful default so new projects aren't empty.

INSERT INTO project_checklist_templates (id, name, description) VALUES
  (1, 'Exhibition (default)', 'Standard checklist for multi-brand exhibition participation'),
  (2, 'Solo (default)',       'Standard checklist for single-brand solo events');

INSERT INTO project_checklist_template_items
  (template_id, seq, title, required_perm, due_offset_days, description) VALUES
  -- Exhibition
  (1,  10, 'Agreement / quotation approved',       NULL,                -30, 'Contract signed with organizer'),
  (1,  20, 'Floorplan received from organizer',    NULL,                -25, NULL),
  (1,  30, 'Floorplan sent to booth designer',     NULL,                -21, NULL),
  (1,  40, '3D render — MGT review',               NULL,                -14, NULL),
  (1,  50, '3D render — final approval',           'projects.approve',  -10, 'Gate: only users with projects.approve can tick'),
  (1,  60, '3D render uploaded to Notion',         NULL,                 -7, NULL),
  (1,  70, 'License (Majlis)',                     NULL,                 -7, NULL),
  (1,  80, 'Work / loading bay permit',            NULL,                 -3, NULL),
  (1,  90, 'Setup / build',                        NULL,                 -1, 'Booth construction on-site'),
  (1, 100, 'Event live',                           NULL,                  0, NULL),
  (1, 110, 'Dismantle',                            NULL,                  1, 'Teardown after event close'),
  (1, 120, 'Security deposit refund follow-up',    NULL,                 14, NULL),
  (1, 130, 'Sales report',                         NULL,                  7, 'Post-event sales summary'),
  -- Solo
  (2,  10, 'Venue confirmed',                      NULL,                -30, NULL),
  (2,  20, 'Floorplan finalised',                  NULL,                -21, NULL),
  (2,  30, '3D render — MGT review',               NULL,                -14, NULL),
  (2,  40, '3D render — final approval',           'projects.approve',  -10, NULL),
  (2,  50, 'Marketing / promo kickoff',            NULL,                 -7, NULL),
  (2,  60, 'Setup / build',                        NULL,                 -1, NULL),
  (2,  70, 'Event live',                           NULL,                  0, NULL),
  (2,  80, 'Dismantle',                            NULL,                  1, NULL),
  (2,  90, 'Sales report',                         NULL,                  7, NULL);

INSERT INTO project_event_types (slug, name, default_template_id, sort_order) VALUES
  ('exhibition', 'Exhibition', 1, 10),
  ('solo',       'Solo',       2, 20);
