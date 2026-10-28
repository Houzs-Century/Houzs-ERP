-- D1 test mirror of migrations-pg/0151_client_errors.sql. The reasoning lives
-- in that file; this keeps the vitest D1 schema in step so the client-error
-- endpoint + dedup + digest suites exercise the real columns. Same TEXT ISO
-- timestamps (the app writes them explicitly; the defaults are a safety net in
-- the identical format).
CREATE TABLE client_errors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  TEXT NOT NULL,
  day          TEXT NOT NULL,
  user_id      INTEGER NOT NULL DEFAULT 0,
  company_id   INTEGER,
  route        TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  stack        TEXT,
  build_id     TEXT NOT NULL DEFAULT '',
  user_agent   TEXT,
  dedup_hash   TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE UNIQUE INDEX idx_client_errors_dedup
  ON client_errors (dedup_hash, day, user_id);

CREATE INDEX idx_client_errors_last_seen
  ON client_errors (last_seen_at);
