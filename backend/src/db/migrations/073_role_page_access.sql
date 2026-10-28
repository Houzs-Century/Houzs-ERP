-- 073_role_page_access.sql
--
-- Per-page access model — Phase 1 (infrastructure).
--
-- Each row says "role R has level L on page P", where L is one of
-- 'none' / 'partial' / 'full'. Rows are populated by the one-shot
-- backfill script `scripts/backfill-role-page-access.mjs`, which
-- translates each role's existing permission JSON into per-page
-- levels using the rules defined in `services/pageAccess.ts`.
--
-- The `*` wildcard on a role's `permissions` array still bypasses
-- the matrix entirely — `requirePageAccess` short-circuits to 'full'
-- when the user holds `*`. So Owner / IT Admin don't need rows here
-- (but the backfill writes them anyway for visibility in the admin
-- UI matrix).
--
-- The CHECK constraint enforces the enum at the DB level; the
-- application layer is the only writer, but defense in depth is free.

CREATE TABLE IF NOT EXISTS role_page_access (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  page_key   TEXT    NOT NULL,
  level      TEXT    NOT NULL CHECK (level IN ('none','partial','full')),
  created_at TEXT    DEFAULT (datetime('now')),
  updated_at TEXT    DEFAULT (datetime('now')),
  PRIMARY KEY (role_id, page_key)
);

CREATE INDEX IF NOT EXISTS idx_role_page_access_role
  ON role_page_access(role_id);
