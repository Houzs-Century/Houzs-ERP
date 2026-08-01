-- Server-stored TABLE LAYOUTS (owner 2026-08-01).
--
-- Two problems, one table:
--
--   1. A company's DEFAULT view had to be a code constant, so moving a column
--      for everyone in 2990 meant a PR and a deploy. `user_id IS NULL` rows are
--      that default, written from the Columns panel by a settings.manage admin.
--   2. Every column arrangement lived in localStorage, so a user who opened the
--      ERP on another machine re-arranged 44 columns by hand. `user_id IS NOT
--      NULL` rows are that user's own layout, synced across their devices.
--
-- Resolution order at render time (frontend, lib/tableLayouts.ts):
--   this user's row → this company's default row → the page's code preset →
--   the columns' own defaultHidden flags. Every step is a fallback, never a
--   lock: a user's row always wins over the admin default, which is what makes
--   changing the default safe.
--
-- `layout` is TEXT holding JSON, deliberately NOT jsonb: the D1 compatibility
-- shim double-serialises jsonb parameters (the #1406 SO-amendment 500), and
-- this column is read on every list page. Parse/stringify explicitly in code.
--
-- table_key is the frontend's LAYOUT FAMILY (`layoutFamily || tableId`), e.g.
-- 'sales-orders-v2' — never a per-document id, or this table would grow one row
-- per document ever opened (the same rule DataTable's storage keys follow).
CREATE TABLE IF NOT EXISTS table_layouts (
  id bigserial PRIMARY KEY,
  company_id bigint NOT NULL,
  -- NULL = this company's default, written by an admin. Otherwise the layout
  -- belongs to that user, in that company.
  user_id bigint,
  table_key text NOT NULL,
  -- JSON: { order: string[], hidden: string[], shown: string[],
  --         widths: Record<string, number>, pinned: string[] }
  -- Filters / sort / card-vs-table stay device-local on purpose: they are
  -- working state, not a layout.
  layout text NOT NULL,
  updated_at text DEFAULT to_char(timezone('UTC', now()), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  updated_by bigint
);

-- One default per (company, table), and one row per (company, table, user).
-- Partial indexes rather than a single unique over a nullable column: in SQL,
-- NULLs don't collide, so `UNIQUE (company_id, user_id, table_key)` would let a
-- company accumulate any number of "the" default.
CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_company_default
  ON table_layouts (company_id, table_key)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_user
  ON table_layouts (company_id, table_key, user_id)
  WHERE user_id IS NOT NULL;

-- The boot read is "everything this user can see in this company", so both row
-- kinds are fetched by company in one query.
CREATE INDEX IF NOT EXISTS idx_table_layouts_company_user
  ON table_layouts (company_id, user_id);

COMMENT ON TABLE table_layouts IS
  'Column layouts per (company, table): user_id NULL = the company default written by a settings.manage admin; user_id set = that user''s own layout, synced across their devices. A user row always beats the default.';

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS table_layouts;
