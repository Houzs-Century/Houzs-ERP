-- D1 / SQLite parity for PG migration 0235 — server-stored column layouts
-- (company default + per-user, owner 2026-08-01). Test mirror only; prod runs
-- Postgres. Keep the shape in lockstep with 0235_table_layouts.sql.
CREATE TABLE IF NOT EXISTS table_layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  -- NULL = the company default (admin-written); otherwise that user's layout.
  user_id INTEGER,
  table_key TEXT NOT NULL,
  -- JSON text, not a JSON type: the d1-compat shim double-serialises jsonb.
  layout TEXT NOT NULL,
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_company_default
  ON table_layouts (company_id, table_key)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_user
  ON table_layouts (company_id, table_key, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_table_layouts_company_user
  ON table_layouts (company_id, user_id);
