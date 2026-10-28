-- 0074_search_trgm_indexes.sql — pg_trgm GIN indexes backing system-wide search.
--
-- The global search route (src/routes/search.ts) probes several text columns
-- with ILIKE '%term%'. A trigram GIN index turns each substring probe from a
-- sequential scan into an index scan (~10-100ms at scale) — the same pattern
-- proven on Hookka (their mig 0150) and already applied for the PUBLIC-schema
-- sources in 0001_search_trgm.sql.
--
-- This migration ADDS the sources that grew into search since 0001:
--   * scm.mfg_sales_orders  — the B2B Sales Order source (doc_no / debtor_name /
--     ref / phone / po_doc_no). These live in the dedicated `scm` Postgres
--     schema (PostgREST), so they must be schema-qualified here. Customer search
--     is covered here too (debtor_name / phone are the customer identity on a
--     Houzs SO — there is no separate scm.customers master to index).
--   * scm.mfg_products      — Product/SKU source (code / name).
--
-- Every statement is idempotent (CREATE EXTENSION / INDEX IF NOT EXISTS) so a
-- re-run against the live DB is a no-op. Postgres-only — the D1 test fallback
-- never runs this file. NOT CONCURRENTLY: the migration runner wraps each file
-- in a transaction, and CREATE INDEX CONCURRENTLY cannot run inside one; a plain
-- build is fine here (index build locks are brief on these tables).
--
-- The columns referenced below may not all exist in every environment (schema
-- drift on the ported scm tables). `IF NOT EXISTS` guards the INDEX name only,
-- not the column — if a column is genuinely absent the statement errors, which
-- is the intended signal (fix the column name, don't ship a half-index). All
-- names were verified against scm/routes/mfg-sales-orders.ts HEADER/LIST cols.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Reaffirm the public-schema search indexes (idempotent — no-op if 0001 ran).
CREATE INDEX IF NOT EXISTS trgm_proj_code       ON projects USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proj_name       ON projects USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proj_venue      ON projects USING gin (venue gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proj_organizer  ON projects USING gin (organizer gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proj_brand      ON projects USING gin (brand gin_trgm_ops);

-- scm.mfg_sales_orders — the Sales Order source for global search.
CREATE INDEX IF NOT EXISTS trgm_mfg_so_doc_no      ON scm.mfg_sales_orders USING gin (doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_so_debtor_name ON scm.mfg_sales_orders USING gin (debtor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_so_ref         ON scm.mfg_sales_orders USING gin (ref gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_so_phone       ON scm.mfg_sales_orders USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_so_po_doc_no   ON scm.mfg_sales_orders USING gin (po_doc_no gin_trgm_ops);

-- scm.mfg_products — Product/SKU source (code / name / description).
CREATE INDEX IF NOT EXISTS trgm_mfg_prod_code ON scm.mfg_products USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_prod_name ON scm.mfg_products USING gin (name gin_trgm_ops);
