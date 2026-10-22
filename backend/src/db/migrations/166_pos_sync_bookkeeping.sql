-- D1 / test-tree twin of migrations-pg/20261014T1445_pos_sync_bookkeeping.sql.
ALTER TABLE pos_sales ADD COLUMN stock_warning TEXT;
ALTER TABLE pos_terminals ADD COLUMN last_known_pending_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_terminals ADD COLUMN last_known_pending_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_terminals ADD COLUMN db_empty_at TEXT;

CREATE TABLE IF NOT EXISTS pos_heartbeats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL,
  terminal_id   INTEGER NOT NULL REFERENCES pos_terminals (id) ON DELETE CASCADE,
  at            TEXT NOT NULL DEFAULT (datetime('now')),
  payload       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_pos_heartbeats_terminal_at ON pos_heartbeats (terminal_id, at);

CREATE TABLE IF NOT EXISTS pos_alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL,
  type            TEXT NOT NULL,
  terminal_id     INTEGER REFERENCES pos_terminals (id) ON DELETE CASCADE,
  project_id      INTEGER,
  detail          TEXT NOT NULL DEFAULT '{}',
  email_sent_at   TEXT,
  last_resent_at  TEXT,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
