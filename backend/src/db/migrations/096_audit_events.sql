-- 096_audit_events.sql (D1/SQLite — vitest + parity). Mirror of
-- migrations-pg/0006_audit_events.sql. Append-only audit ledger: writeAudit()
-- records one row per security-relevant mutation (role/permission edits, user
-- invites + status flips, finance edits) with actor, entity, a human summary
-- and a JSON before/after blob. Best-effort at the call site so a failed audit
-- insert never breaks the mutation it records. No UPDATE/DELETE path.
CREATE TABLE IF NOT EXISTS audit_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT DEFAULT (datetime('now')),
  actor_id    INTEGER,
  actor_email TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  summary     TEXT,
  meta        TEXT,
  ip          TEXT,
  request_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created ON audit_events (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_id);
