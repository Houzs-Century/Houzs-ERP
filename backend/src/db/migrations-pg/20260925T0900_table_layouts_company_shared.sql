-- Company-SHARED named layouts (owner 2026-09-25) — the extension mig 0252's
-- own comment foresaw ("a shared layout would be a new visibility column, not a
-- rewrite").
--
-- Until now every `user_id IS NULL` row was THE company default (one per company
-- per table, optionally named). A team-wide layout PICKER — the four curated
-- Delivery Planning views an admin can edit for everyone at once — needs more
-- than one company-owned row per table, but must NOT be mistaken for the single
-- default. `is_shared` is that discriminator (0/1 to match the rest of the
-- schema and the D1 test mirror):
--
--   user_id IS NULL, is_shared = 0  → the one company default (unchanged).
--   user_id IS NULL, is_shared = 1  → a company-shared NAMED layout, keyed by
--                                     name, edited by a layout manager, seen by
--                                     everyone in the company.
--   user_id IS NOT NULL             → that user's live row / saved layouts.
--
-- Existing rows default to is_shared = 0, so nothing about the current default /
-- per-user behaviour changes.
ALTER TABLE table_layouts ADD COLUMN IF NOT EXISTS is_shared integer NOT NULL DEFAULT 0;

-- The old "one row per (company, table) where user_id IS NULL" unique would now
-- also cover the shared rows and forbid a second one. Narrow it to the default,
-- and give the shared rows their own name-unique index.
DROP INDEX IF EXISTS uq_table_layouts_company_default;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_company_default
  ON table_layouts (company_id, table_key)
  WHERE user_id IS NULL AND is_shared = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_company_shared
  ON table_layouts (company_id, table_key, lower(name))
  WHERE user_id IS NULL AND is_shared = 1;

COMMENT ON COLUMN table_layouts.is_shared IS
  'user_id IS NULL only: 0 = the one company default; 1 = a company-shared named layout (a layout manager edits it, everyone in the company sees it).';

-- REVERSAL:
-- DROP INDEX IF EXISTS uq_table_layouts_company_shared;
-- DROP INDEX IF EXISTS uq_table_layouts_company_default;
-- DELETE FROM table_layouts WHERE user_id IS NULL AND is_shared = 1;
-- CREATE UNIQUE INDEX uq_table_layouts_company_default
--   ON table_layouts (company_id, table_key) WHERE user_id IS NULL;
-- ALTER TABLE table_layouts DROP COLUMN is_shared;
