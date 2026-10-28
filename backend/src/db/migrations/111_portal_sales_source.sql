-- 111_portal_sales_source.sql
-- Sales portal links: per-case tokens with source='sales' render the
-- salesperson variant of the customer portal (full stage progress,
-- comments/uploads attributed to sales).
--
-- Prod Postgres carries no CHECK constraints on these columns (the
-- cutover baseline dropped them), so this is a TEST-MIRROR-ONLY
-- rebuild: SQLite can't alter a CHECK, so each table is copied into
-- a replacement whose source CHECK admits 'sales'. Nothing references
-- these tables, so drop+rename is FK-safe.

-- ── case_track_tokens ────────────────────────────────────────
CREATE TABLE case_track_tokens_new (
  token TEXT PRIMARY KEY,
  assr_id INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'customer'
    CHECK(source IN ('customer','staff','sales')),
  verified_phone TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
INSERT INTO case_track_tokens_new
  SELECT token, assr_id, source, verified_phone, expires_at, created_at
    FROM case_track_tokens;
DROP TABLE case_track_tokens;
ALTER TABLE case_track_tokens_new RENAME TO case_track_tokens;
CREATE INDEX idx_case_track_assr ON case_track_tokens(assr_id);
CREATE INDEX idx_case_track_exp ON case_track_tokens(expires_at);

-- ── assr_activity ────────────────────────────────────────────
CREATE TABLE assr_activity_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  note TEXT,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  customer_id INTEGER,
  source TEXT DEFAULT 'staff'
    CHECK(source IN ('staff','customer','system','sales')),
  archived_at TEXT,
  archived_by INTEGER,
  category TEXT DEFAULT 'system'
    CHECK (category IN ('purchasing','customer','system')),
  stage_elapsed_days REAL,
  stage_target_days REAL,
  source_channel TEXT,
  references_entry_id INTEGER,
  is_correction INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
INSERT INTO assr_activity_new
  SELECT id, assr_id, action, from_value, to_value, note, user_id,
         created_at, customer_id, source, archived_at, archived_by,
         category, stage_elapsed_days, stage_target_days,
         source_channel, references_entry_id, is_correction
    FROM assr_activity;
DROP TABLE assr_activity;
ALTER TABLE assr_activity_new RENAME TO assr_activity;
CREATE INDEX idx_assr_activity_case ON assr_activity(assr_id);
CREATE INDEX idx_assr_activity_archived ON assr_activity(archived_at);
CREATE INDEX idx_assr_activity_category ON assr_activity(assr_id, category);
CREATE INDEX idx_assr_activity_source ON assr_activity(source_channel);
CREATE INDEX idx_assr_activity_refs ON assr_activity(references_entry_id);

-- ── assr_attachments ─────────────────────────────────────────
CREATE TABLE assr_attachments_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assr_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  file_name TEXT,
  content_type TEXT,
  category TEXT DEFAULT 'complaint'
    CHECK(category IN ('complaint','evidence','completion','signature')),
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  customer_id INTEGER,
  source TEXT DEFAULT 'staff'
    CHECK(source IN ('staff','customer','system','sales')),
  visible_to_customer INTEGER DEFAULT 1,
  archived_at TEXT,
  archived_by INTEGER,
  FOREIGN KEY (assr_id) REFERENCES assr_cases(id) ON DELETE CASCADE
);
INSERT INTO assr_attachments_new
  SELECT id, assr_id, r2_key, file_name, content_type, category,
         uploaded_by, created_at, customer_id, source,
         visible_to_customer, archived_at, archived_by
    FROM assr_attachments;
DROP TABLE assr_attachments;
ALTER TABLE assr_attachments_new RENAME TO assr_attachments;
CREATE INDEX idx_assr_attachments_case ON assr_attachments(assr_id);
CREATE INDEX idx_assr_attachments_archived ON assr_attachments(archived_at);
