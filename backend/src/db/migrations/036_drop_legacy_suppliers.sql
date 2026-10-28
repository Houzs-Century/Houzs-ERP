-- 036_drop_legacy_suppliers.sql
-- Phase 5 cleanup: remove every artefact of the old local Suppliers +
-- Supplier Portal modules, now that ASSR cases are keyed by
-- AutoCount creditor_code and no UI writes supplier_* anywhere.
--
-- Audit at the time this migration was written:
--   suppliers               : 1 row  (test data)
--   supplier_accounts       : 0 rows
--   supplier_sessions       : 0 rows
--   supplier_invitations    : 0 rows
--   supplier_communications : 0 rows
--   assr_cases.supplier_id  : 2 legacy rows (pre-Phase-3 cases)
--   projects.contractor_id  : 0 rows set, write-dead UI

-- 1) Portal tables — drop outright.
DROP TABLE IF EXISTS supplier_communications;
DROP TABLE IF EXISTS supplier_invitations;
DROP TABLE IF EXISTS supplier_sessions;
DROP TABLE IF EXISTS supplier_accounts;

-- 2) assr_cases — drop legacy supplier_* columns.
-- SQLite refuses to DROP a column that an index references, so we
-- kill each index first. All defensively IF EXISTS since we don't
-- know exactly which migration created which index.
DROP INDEX IF EXISTS idx_assr_supplier_id;
DROP INDEX IF EXISTS idx_assr_supplier_job_status;
DROP INDEX IF EXISTS idx_assr_supplier_rating;
DROP INDEX IF EXISTS idx_assr_supplier_rated_at;
DROP INDEX IF EXISTS idx_assr_supplier_rated_by;

ALTER TABLE assr_cases DROP COLUMN supplier_id;
ALTER TABLE assr_cases DROP COLUMN supplier;
ALTER TABLE assr_cases DROP COLUMN supplier_rating;
ALTER TABLE assr_cases DROP COLUMN supplier_rating_notes;
ALTER TABLE assr_cases DROP COLUMN supplier_rated_at;
ALTER TABLE assr_cases DROP COLUMN supplier_rated_by;
ALTER TABLE assr_cases DROP COLUMN supplier_job_status;
ALTER TABLE assr_cases DROP COLUMN supplier_job_updated_at;

-- 3) projects.contractor_id — blocked by a FOREIGN KEY in the table
--    DDL, so ALTER TABLE DROP COLUMN won't work. Rebuild the table
--    without the column + the FK, copy data over, swap.
--
--    The "contractor" concept here was a booth-builder, not a PO
--    creditor and not a service repair vendor. No UI ever wrote it
--    (zero rows have it set), so there's nothing to migrate.
DROP INDEX IF EXISTS idx_projects_stage;
DROP INDEX IF EXISTS idx_projects_brand;
DROP INDEX IF EXISTS idx_projects_start;
DROP INDEX IF EXISTS idx_projects_archived;
DROP INDEX IF EXISTS idx_projects_payment;

CREATE TABLE projects_new (
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
  brand TEXT
    CHECK (brand IS NULL OR brand IN ('AKEMI','ZANOTTI','DUNLOPILLO','ERGOTEX','MY SOFA FACTORY','AKEMI C&C')),
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
  FOREIGN KEY (event_type_id) REFERENCES project_event_types(id) ON DELETE SET NULL
);

INSERT INTO projects_new (
  id, code, name, stage, start_date, end_date, organizer, state, venue, venue_address,
  brand, event_type_id, booth_no, size_sqm, notion_url, notes,
  created_by, created_at, updated_at, archived_at, archived_by,
  setup_start_at, setup_end_at, dismantle_start_at, dismantle_end_at,
  setup_driver_user_id, setup_lorry_id, dismantle_driver_user_id, dismantle_lorry_id,
  banner_message, banner_tone,
  payment_status, payment_proof_r2_key, payment_proof_file_name,
  payment_notes, payment_updated_at, payment_updated_by
)
SELECT
  id, code, name, stage, start_date, end_date, organizer, state, venue, venue_address,
  brand, event_type_id, booth_no, size_sqm, notion_url, notes,
  created_by, created_at, updated_at, archived_at, archived_by,
  setup_start_at, setup_end_at, dismantle_start_at, dismantle_end_at,
  setup_driver_user_id, setup_lorry_id, dismantle_driver_user_id, dismantle_lorry_id,
  banner_message, banner_tone,
  payment_status, payment_proof_r2_key, payment_proof_file_name,
  payment_notes, payment_updated_at, payment_updated_by
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

-- Recreate the indexes we dropped above.
CREATE INDEX IF NOT EXISTS idx_projects_stage    ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_brand    ON projects(brand);
CREATE INDEX IF NOT EXISTS idx_projects_start    ON projects(start_date);
CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(archived_at);
CREATE INDEX IF NOT EXISTS idx_projects_payment  ON projects(payment_status);

-- 4) Finally the `suppliers` table itself. Nothing references it now.
DROP TABLE IF EXISTS suppliers;
