-- 169_role_page_access.sql — D1 test mirror of migrations-pg/20261019T1300.
--
-- Recreates the per-role page-access table dropped in 158 (mirror of
-- migrations-pg/20260917T0900). The RBAC rebuild (Option A) makes the role the
-- single source of page access; hydrateAuthUser reads these rows for every
-- member and falls back to the position policy / permission backfill when a role
-- has none, so an empty table (the state in every test) is a no-op. See the PG
-- migration for the full rationale.
--
-- `level` is plain TEXT (no CHECK): the resolver's vocabulary is
-- none/partial/view/edit/full, so the old 073 CHECK (none/partial/full only)
-- would reject the position levels the seed writes.

CREATE TABLE IF NOT EXISTS role_page_access (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  page_key   TEXT    NOT NULL,
  level      TEXT    NOT NULL,
  created_at TEXT    DEFAULT (datetime('now')),
  updated_at TEXT    DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, page_key)
);

CREATE INDEX IF NOT EXISTS idx_role_page_access_role
  ON role_page_access(role_id);
