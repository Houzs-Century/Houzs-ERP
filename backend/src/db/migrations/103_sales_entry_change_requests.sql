-- Test-schema mirror of migrations-pg/0052 — the sales-entry change-request
-- (edit-approval) queue. Keeps the vitest D1 schema in lockstep with prod PG so
-- the approval-workflow queries run in the suite.
CREATE TABLE IF NOT EXISTS sales_entry_change_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id     INTEGER NOT NULL REFERENCES sales_entries(id) ON DELETE CASCADE,
  payload      TEXT NOT NULL,
  summary      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','rejected','superseded')),
  requested_by INTEGER,
  decided_by   INTEGER,
  decided_at   TEXT,
  decide_note  TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_secr_entry_status ON sales_entry_change_requests (entry_id, status);
CREATE INDEX IF NOT EXISTS idx_secr_status ON sales_entry_change_requests (status);
