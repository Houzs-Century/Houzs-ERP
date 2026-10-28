-- 061_idea_comments.sql
--
-- Comments on innovation + suggestion posts. Polymorphic discriminator
-- table — same shape as `votes` (mig 057) and `idea_attachments` (mig 059).
-- Soft-archive via `archived_at` so deletes preserve audit history.
-- Comments do not award points; they are a social signal only.

CREATE TABLE idea_comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type   TEXT NOT NULL CHECK (target_type IN ('innovation','suggestion')),
  target_id     INTEGER NOT NULL,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now')),
  edited_at     TEXT,
  archived_at   TEXT
);

CREATE INDEX idx_idea_comments_target
  ON idea_comments(target_type, target_id, archived_at);

CREATE INDEX idx_idea_comments_user
  ON idea_comments(user_id);
