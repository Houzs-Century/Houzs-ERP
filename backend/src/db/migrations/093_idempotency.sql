-- Idempotency keys (D1 / SQLite — local dev, vitest, rollback parity).
-- Mirror of migrations-pg/0003_idempotency.sql. See that file for rationale.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            TEXT    NOT NULL,
  scope          TEXT    NOT NULL,
  user_id        INTEGER,
  status_code    INTEGER,
  response_body  TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (key, scope)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON idempotency_keys (created_at);
