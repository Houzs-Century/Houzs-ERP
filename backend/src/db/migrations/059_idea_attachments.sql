-- 059_idea_attachments.sql
--
-- Polymorphic attachments for innovation + suggestion posts. Mirrors
-- the project_checklist_attachments pattern (mig 050): R2 holds the
-- bytes, this table carries the key + metadata. Soft-archived via
-- archived_at so deletion preserves history.
--
-- Migrations are immutable — fix forward in a new file.

CREATE TABLE IF NOT EXISTS idea_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT NOT NULL CHECK (target_type IN ('innovation','suggestion')),
  target_id     INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    INTEGER,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT DEFAULT (datetime('now')),
  archived_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_idea_att_target
  ON idea_attachments(target_type, target_id, archived_at);
