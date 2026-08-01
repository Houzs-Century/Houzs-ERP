-- D1 / SQLite parity for PG migration 0239 — named layouts. Test mirror only;
-- prod runs Postgres. Keep the shape in lockstep with 0239.
--
--   name IS NULL      the live arrangement (one per company/table/user)
--   name IS NOT NULL  a saved layout the user can switch back to
ALTER TABLE table_layouts ADD COLUMN name TEXT;

DROP INDEX IF EXISTS uq_table_layouts_user;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_user_current
  ON table_layouts (company_id, table_key, user_id)
  WHERE user_id IS NOT NULL AND name IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_table_layouts_user_named
  ON table_layouts (company_id, table_key, user_id, lower(name))
  WHERE user_id IS NOT NULL AND name IS NOT NULL;
