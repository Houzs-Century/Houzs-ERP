-- D1 / SQLite parity for PG migration 20260925T0900 — company-SHARED named
-- layouts. Test mirror only; prod runs Postgres. Keep the shape in lockstep with
-- 20260925T0900_table_layouts_company_shared.sql.
--
-- is_shared discriminates the user_id IS NULL rows: 0 = the one company default
-- (unchanged), 1 = a company-shared named layout (a layout manager edits it,
-- everyone in the company sees it).
ALTER TABLE table_layouts ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS uq_table_layouts_company_default;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_company_default
  ON table_layouts (company_id, table_key)
  WHERE user_id IS NULL AND is_shared = 0;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_company_shared
  ON table_layouts (company_id, table_key, lower(name))
  WHERE user_id IS NULL AND is_shared = 1;
