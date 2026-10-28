-- 044_brand_config.sql
-- Makes the brand dropdown maintainable from Project Maintenance.
--
-- Two moving parts:
--   1) New `project_brands` lookup table with label/colour/sort_order
--      so admins can add brands and tweak how they look without a
--      deploy. Seeded with the original six.
--   2) Full-table rebuild of `projects` to drop the CHECK constraint
--      that limited `brand` to those six names. SQLite's only way to
--      drop a CHECK is a rebuild; the pattern matches migration 036
--      (which rebuilt projects to remove the contractor FK). Every
--      column + the event_type_id FK + pic_id FK + every index from
--      039 is carried through.

-- ── 1. New lookup table ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_brands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  -- 6-char hex (no '#'). Used for chart/list chips.
  color      TEXT NOT NULL DEFAULT '64748b',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Seed with the pre-existing six. These are the values the CHECK
-- constraint allowed. Colours chosen to match the existing frontend
-- brand palette in Projects.tsx (BRAND_COLORS) where possible.
INSERT OR IGNORE INTO project_brands (name, color, sort_order) VALUES
  ('AKEMI',           '10b981', 10),
  ('ZANOTTI',         '3b82f6', 20),
  ('DUNLOPILLO',      '8b5cf6', 30),
  ('ERGOTEX',         'f59e0b', 40),
  ('MY SOFA FACTORY', 'ec4899', 50),
  ('AKEMI C&C',       '06b6d4', 60);

-- ── 2. Rebuild `projects` without the brand CHECK ───────────────
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
    CHECK (stage IN ('draft','planning','build','live','teardown','closed','cancelled')),
  start_date TEXT,
  end_date TEXT,
  organizer TEXT,
  state TEXT,
  venue TEXT,
  venue_address TEXT,
  brand TEXT,                     -- CHECK removed; enforcement moves to project_brands + app layer
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
  id, code, name, stage, start_date, end_date, organizer, state, venue, venue_address,
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
