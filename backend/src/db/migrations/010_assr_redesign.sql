-- 010_assr_redesign.sql
-- Evolve flat assr_cases into a multi-stage workflow with child tables.

-- ── New columns on existing assr_cases ────────────────────────────
ALTER TABLE assr_cases ADD COLUMN stage TEXT NOT NULL DEFAULT 'registration'
  CHECK(stage IN ('registration','triage','action','logistics','resolution','closed'));

ALTER TABLE assr_cases ADD COLUMN resolution_method TEXT
  CHECK(resolution_method IS NULL OR resolution_method IN (
    'replace_unit','supplier_repair','field_service_own','field_service_supplier','return_visit'
  ));

ALTER TABLE assr_cases ADD COLUMN issue_category TEXT;

ALTER TABLE assr_cases ADD COLUMN priority TEXT DEFAULT 'normal'
  CHECK(priority IN ('low','normal','high','urgent'));

ALTER TABLE assr_cases ADD COLUMN assigned_to INTEGER;

ALTER TABLE assr_cases ADD COLUMN ref_no TEXT;
ALTER TABLE assr_cases ADD COLUMN delivery_order TEXT;
ALTER TABLE assr_cases ADD COLUMN do_date TEXT;
ALTER TABLE assr_cases ADD COLUMN closed_at TEXT;
ALTER TABLE assr_cases ADD COLUMN created_by INTEGER;
ALTER TABLE assr_cases ADD COLUMN satisfaction_rating INTEGER;
ALTER TABLE assr_cases ADD COLUMN satisfaction_notes TEXT;

-- Backfill stage from existing status for old rows
UPDATE assr_cases SET stage = 'closed' WHERE status = 'Closed';
UPDATE assr_cases SET stage = 'action' WHERE status = 'In Progress';
-- 'Open' rows keep the default 'registration'

CREATE INDEX IF NOT EXISTS idx_assr_stage ON assr_cases(stage);
CREATE INDEX IF NOT EXISTS idx_assr_assigned ON assr_cases(assigned_to);

-- ── Items selected for service from the SO ────────────────────────
CREATE TABLE assr_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  item_code TEXT NOT NULL,
  item_description TEXT,
  qty INTEGER DEFAULT 1,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
CREATE INDEX idx_assr_items_case ON assr_items(assr_id);

-- ── Photos, videos, completion evidence ───────────────────────────
CREATE TABLE assr_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  file_name TEXT,
  content_type TEXT,
  category TEXT DEFAULT 'complaint'
    CHECK(category IN ('complaint','evidence','completion','signature')),
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
CREATE INDEX idx_assr_attachments_case ON assr_attachments(assr_id);

-- ── Audit trail: stage transitions, notes, assignments ────────────
CREATE TABLE assr_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
CREATE INDEX idx_assr_activity_case ON assr_activity(assr_id);

-- ── Logistics scheduling for pickup / delivery ────────────────────
CREATE TABLE assr_logistics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('pickup','delivery')),
  scheduled_date TEXT,
  scheduled_time_range TEXT,
  assigned_to INTEGER,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','scheduled','completed','cancelled')),
  notes TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
CREATE INDEX idx_assr_logistics_case ON assr_logistics(assr_id);

-- ── Grant service_cases.write + manage to Dispatcher role ─────
UPDATE roles
   SET permissions = REPLACE(permissions, '"service_cases.read"', '"service_cases.read","service_cases.write","service_cases.manage"')
 WHERE name = 'Dispatcher'
   AND permissions LIKE '%"service_cases.read"%'
   AND permissions NOT LIKE '%"service_cases.manage"%';
