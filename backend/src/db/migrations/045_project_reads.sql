-- 045_project_reads.sql
-- Per-user last-read timestamp per project. Drives the unread dot on
-- the Projects list and the notification bell's "since" cursor.
--
-- Key choice: (user_id, project_id) composite PK. A row only exists
-- after the user has opened a given project at least once. Before
-- that, COALESCE(last_read_at, '1970-01-01') falls back so every
-- activity item counts as "unread" on first load — which matches
-- what a new user would expect.

CREATE TABLE IF NOT EXISTS project_reads (
  user_id       INTEGER NOT NULL,
  project_id    INTEGER NOT NULL,
  last_read_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, project_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_reads_user
  ON project_reads(user_id, last_read_at DESC);
