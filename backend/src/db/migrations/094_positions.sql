-- 094_positions.sql (D1 / SQLite — local dev, vitest, rollback parity).
-- Mirror of migrations-pg/0004_positions.sql. See that file for rationale.
-- Positions = the staff org dimension (department + position); the unit the
-- User-Management permission matrix is keyed on.

CREATE TABLE IF NOT EXISTS positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id INTEGER REFERENCES departments(id),
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  level         INTEGER NOT NULL DEFAULT 100,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now'))
);

ALTER TABLE users ADD COLUMN position_id INTEGER REFERENCES positions(id);
CREATE INDEX IF NOT EXISTS idx_users_position ON users(position_id);

ALTER TABLE invitations ADD COLUMN position_id INTEGER;
ALTER TABLE invitations ADD COLUMN department_id INTEGER;
ALTER TABLE invitations ADD COLUMN manager_id INTEGER;

CREATE TABLE IF NOT EXISTS position_page_access (
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  page_key    TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('none','view','edit','full')),
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (position_id, page_key)
);

CREATE INDEX IF NOT EXISTS idx_position_page_access_position ON position_page_access(position_id);
