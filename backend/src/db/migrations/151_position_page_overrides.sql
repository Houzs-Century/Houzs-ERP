-- 151_position_page_overrides — D1 test mirror of migrations-pg/0323.
-- Owner-editable SCM module access per position: overrides applied over the
-- code-defined position policy at session hydration. No seeds — zero rows
-- means the policy baseline, unchanged.

CREATE TABLE IF NOT EXISTS position_page_overrides (
  position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  page_key    TEXT    NOT NULL,
  level       TEXT    NOT NULL CHECK (level IN ('none', 'view', 'edit', 'full')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by  INTEGER,
  PRIMARY KEY (position_id, page_key)
);
