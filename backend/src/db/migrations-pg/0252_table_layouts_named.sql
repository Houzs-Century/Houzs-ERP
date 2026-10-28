-- NAMED layouts (owner 2026-08-02) — the Columns drawer's layout picker can
-- now hold more than "this company's default" and "whatever I last arranged".
--
-- A named row is a SAVED COLUMN SET, not a live pointer: switching to one
-- copies it into the user's live arrangement (the unnamed row), which is what
-- keeps the existing sync path — and every guarantee built on it — untouched.
-- So one user, one table, one company now holds:
--
--   name IS NULL      the live arrangement. Exactly the row that existed
--                     before this migration; still exactly one.
--   name IS NOT NULL  a layout they saved and can switch back to.
--
-- Company defaults (user_id IS NULL) are unchanged and stay unnamed.
--
-- Sharing is deliberately NOT here (owner: 先只做「我自己的多套布局 + 公司
-- 默认」). Nothing in this shape forbids it later — a shared layout would be a
-- new visibility column, not a rewrite.
ALTER TABLE table_layouts ADD COLUMN IF NOT EXISTS name text;

-- The old per-user unique allowed exactly ONE row per (company, table, user),
-- which is precisely what "more than one layout" needs relaxed. Replaced by
-- two narrower ones so the live row stays single AND names stay unique.
DROP INDEX IF EXISTS uq_table_layouts_user;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_user_current
  ON table_layouts (company_id, table_key, user_id)
  WHERE user_id IS NOT NULL AND name IS NULL;

-- Case-insensitive: "Finance review" and "finance review" in one picker is a
-- list the operator cannot tell apart.
CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_user_named
  ON table_layouts (company_id, table_key, user_id, lower(name))
  WHERE user_id IS NOT NULL AND name IS NOT NULL;

COMMENT ON COLUMN table_layouts.name IS
  'NULL = the live arrangement (one per company/table/user, and the only shape that existed before mig 0239). Set = a layout the user saved and can switch back to. Company defaults (user_id IS NULL) stay unnamed.';

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DELETE FROM table_layouts WHERE name IS NOT NULL;
-- DROP INDEX IF EXISTS uq_table_layouts_user_named;
-- DROP INDEX IF EXISTS uq_table_layouts_user_current;
-- CREATE UNIQUE INDEX uq_table_layouts_user
--   ON table_layouts (company_id, table_key, user_id) WHERE user_id IS NOT NULL;
-- ALTER TABLE table_layouts DROP COLUMN name;
