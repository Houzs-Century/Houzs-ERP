-- 0036_scm_mrp_warehouse_lead_times.sql — port of 2990 migration 0184.
--
-- Per-warehouse MRP lead times (Commander 2026-06-22).
-- Extend scm.mrp_category_lead_times from (category) to (warehouse_id, category).
-- warehouse_id NULL = the GLOBAL DEFAULT (existing category-only rows become
-- globals). Lookup cascade: (warehouse, category) → (NULL, category) → 0.
-- A PK can't hold a nullable column, so drop the old PK + use a NULLS NOT
-- DISTINCT unique index. Additive + idempotent.
--
-- NOTE: the SCM table was created with `category text PRIMARY KEY` (see
-- backend/scripts/scm-schema/fix-scm-endpoint-drift.mjs), so Postgres auto-named
-- the PK constraint mrp_category_lead_times_pkey — same as 2990. The existing
-- category CHECK constraint is unaffected.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); each statement ends ';'+newline with no internal ';\n'.
ALTER TABLE scm.mrp_category_lead_times ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES scm.warehouses(id) ON DELETE CASCADE;
ALTER TABLE scm.mrp_category_lead_times DROP CONSTRAINT IF EXISTS mrp_category_lead_times_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS mrp_category_lead_times_wh_cat_uniq ON scm.mrp_category_lead_times (warehouse_id, category) NULLS NOT DISTINCT;
