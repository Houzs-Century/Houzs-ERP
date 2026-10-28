-- 010_assr_redesign_fix.sql
-- Safe version: only creates what's missing. D1/SQLite doesn't have IF NOT EXISTS
-- for ALTER TABLE, so we use CREATE TABLE IF NOT EXISTS for child tables
-- and skip ALTER TABLE for columns that may already exist.

-- ── Child tables (safe — IF NOT EXISTS) ───────────────────────

CREATE TABLE IF NOT EXISTS assr_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  item_code TEXT NOT NULL,
  item_description TEXT,
  qty INTEGER DEFAULT 1,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assr_items_case ON assr_items(assr_id);

CREATE TABLE IF NOT EXISTS assr_attachments (
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
CREATE INDEX IF NOT EXISTS idx_assr_attachments_case ON assr_attachments(assr_id);

CREATE TABLE IF NOT EXISTS assr_activity (
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
CREATE INDEX IF NOT EXISTS idx_assr_activity_case ON assr_activity(assr_id);

CREATE TABLE IF NOT EXISTS assr_logistics (
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
CREATE INDEX IF NOT EXISTS idx_assr_logistics_case ON assr_logistics(assr_id);

-- ── Indexes on assr_cases (safe) ──────────────────────────────
CREATE INDEX IF NOT EXISTS idx_assr_stage ON assr_cases(stage);
CREATE INDEX IF NOT EXISTS idx_assr_assigned ON assr_cases(assigned_to);

-- ── Backfill stage from status ────────────────────────────────
UPDATE assr_cases SET stage = 'closed' WHERE status = 'Closed' AND stage = 'registration';
UPDATE assr_cases SET stage = 'action' WHERE status = 'In Progress' AND stage = 'registration';

-- ── Grant permissions to Dispatcher ───────────────────────────
UPDATE roles
   SET permissions = REPLACE(permissions, '"service_cases.read"', '"service_cases.read","service_cases.write","service_cases.manage"')
 WHERE name = 'Dispatcher'
   AND permissions LIKE '%"service_cases.read"%'
   AND permissions NOT LIKE '%"service_cases.manage"%';
