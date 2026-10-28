-- 053_simplify_project_stages.sql
--
-- Stage flow collapses from 7 values to 5:
--   OLD: draft → planning → build → live → teardown → closed (+ cancelled)
--   NEW: draft → setup → live → dismantle → completed
--
-- Remap during the rebuild so no row ends up violating the new CHECK:
--   planning  → setup       (planning + build collapse to a single "setup")
--   build     → setup
--   teardown  → dismantle
--   closed    → completed
--   cancelled → completed   (cancelled was rarely used; folded for now —
--                            re-introduce in a later migration if ops asks)
--   draft, live → unchanged
--
-- Same full-table rebuild pattern as migration 044 (the only way to
-- swap a CHECK constraint in SQLite). Every column from 044 + every
-- index is carried through. Migrations are immutable: fix forward in
-- a new file if anything here turns out wrong.

-- Self-heal step: future db:migrate cycles re-run 044 first, whose
-- INSERT fails once projects holds the new stage values. That leaves an
-- empty projects_rebuild around with 044's OLD CHECK. Drop it so the
-- CREATE below always starts clean.
DROP TABLE IF EXISTS projects_rebuild;

DROP INDEX IF EXISTS idx_projects_stage;
DROP INDEX IF EXISTS idx_projects_brand;
DROP INDEX IF EXISTS idx_projects_start;
DROP INDEX IF EXISTS idx_projects_archived;
DROP INDEX IF EXISTS idx_projects_payment;
DROP INDEX IF EXISTS idx_projects_pic;

CREATE TABLE projects_rebuild (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'draft'
    CHECK (stage IN ('draft','setup','live','dismantle','completed')),
  start_date TEXT,
  end_date TEXT,
  organizer TEXT,
  state TEXT,
  venue TEXT,
  venue_address TEXT,
  brand TEXT,
  event_type_id INTEGER,
  booth_no TEXT,
  size_sqm REAL,
  notion_url TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  archived_at TEXT,
  archived_by INTEGER,
  setup_start_at TEXT,
  setup_end_at TEXT,
  dismantle_start_at TEXT,
  dismantle_end_at TEXT,
  setup_driver_user_id INTEGER,
  setup_lorry_id INTEGER,
  dismantle_driver_user_id INTEGER,
  dismantle_lorry_id INTEGER,
  banner_message TEXT,
  banner_tone TEXT,
  payment_status TEXT DEFAULT 'not_started',
  payment_proof_r2_key TEXT,
  payment_proof_file_name TEXT,
  payment_notes TEXT,
  payment_updated_at TEXT,
  payment_updated_by INTEGER,
  pic_id INTEGER,
  FOREIGN KEY (event_type_id) REFERENCES project_event_types(id) ON DELETE SET NULL,
  FOREIGN KEY (pic_id) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO projects_rebuild (
  id, code, name, stage, start_date, end_date, organizer, state, venue, venue_address,
  brand, event_type_id, booth_no, size_sqm, notion_url, notes,
  created_by, created_at, updated_at, archived_at, archived_by,
  setup_start_at, setup_end_at, dismantle_start_at, dismantle_end_at,
  setup_driver_user_id, setup_lorry_id, dismantle_driver_user_id, dismantle_lorry_id,
  banner_message, banner_tone,
  payment_status, payment_proof_r2_key, payment_proof_file_name,
  payment_notes, payment_updated_at, payment_updated_by,
  pic_id
)
SELECT
  id, code, name,
  CASE stage
    WHEN 'planning'  THEN 'setup'
    WHEN 'build'     THEN 'setup'
    WHEN 'teardown'  THEN 'dismantle'
    WHEN 'closed'    THEN 'completed'
    WHEN 'cancelled' THEN 'completed'
    ELSE stage
  END,
  start_date, end_date, organizer, state, venue, venue_address,
  brand, event_type_id, booth_no, size_sqm, notion_url, notes,
  created_by, created_at, updated_at, archived_at, archived_by,
  setup_start_at, setup_end_at, dismantle_start_at, dismantle_end_at,
  setup_driver_user_id, setup_lorry_id, dismantle_driver_user_id, dismantle_lorry_id,
  banner_message, banner_tone,
  payment_status, payment_proof_r2_key, payment_proof_file_name,
  payment_notes, payment_updated_at, payment_updated_by,
  pic_id
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_rebuild RENAME TO projects;

CREATE INDEX IF NOT EXISTS idx_projects_stage    ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_brand    ON projects(brand);
CREATE INDEX IF NOT EXISTS idx_projects_start    ON projects(start_date);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived_at);
CREATE INDEX IF NOT EXISTS idx_projects_payment  ON projects(payment_status);
CREATE INDEX IF NOT EXISTS idx_projects_pic      ON projects(pic_id);
