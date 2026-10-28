-- 121_activity_category_buckets.sql
-- The timeline note categories moved to four buckets + system
-- (service / customer / supplier / sales / system) back in the
-- 2026-07 refactor, but the test mirror's assr_activity still carried
-- the pre-refactor CHECK ('purchasing','customer','system'), so any
-- test writing category='supplier' (e.g. manual creditor assignment)
-- hit SQLITE_CONSTRAINT.
--
-- Prod Postgres carries no CHECK on this column (the cutover baseline
-- dropped them), so this is a TEST-MIRROR-ONLY rebuild: SQLite can't
-- alter a CHECK, so the table is copied into a replacement whose
-- category CHECK admits the current buckets. Legacy 'purchasing' rows
-- map to 'service', mirroring the server-side legacy mapping.

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
    CHECK (category IN ('service','customer','supplier','sales','system')),
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
         CASE WHEN category = 'purchasing' THEN 'service' ELSE category END,
         stage_elapsed_days, stage_target_days,
         source_channel, references_entry_id, is_correction
    FROM assr_activity;
DROP TABLE assr_activity;
ALTER TABLE assr_activity_new RENAME TO assr_activity;
CREATE INDEX idx_assr_activity_case ON assr_activity(assr_id);
CREATE INDEX idx_assr_activity_archived ON assr_activity(archived_at);
CREATE INDEX idx_assr_activity_category ON assr_activity(assr_id, category);
CREATE INDEX idx_assr_activity_source ON assr_activity(source_channel);
CREATE INDEX idx_assr_activity_refs ON assr_activity(references_entry_id);
