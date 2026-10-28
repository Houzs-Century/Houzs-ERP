-- 0108_perf_trgm_so_debtor.sql — trigram GIN on the Sales Order debtor-search
-- columns.
--
-- The SO list filters `debtor_name ILIKE '%term%'` (mfg-sales-orders.ts:681), the
-- global SO search ORs over `debtor_name` + `phone` (:1131), and the "past SOs by
-- the same debtor name" lookup ILIKEs `debtor_name` (:1419). A plain btree cannot
-- serve a leading-wildcard `'%term%'`, so every one of those is a sequential scan
-- that grows with the SO table. Trigram GIN turns them into index lookups (and
-- backs `similarity()` ranking).
--
-- Mirrors 0074 / 0104. NOT CONCURRENTLY: the migration runner wraps each file in a
-- transaction and CREATE INDEX CONCURRENTLY can't run inside one (it would error
-- and block every deploy). The table is small today so a plain build takes a
-- trivial lock. Every statement is idempotent (IF NOT EXISTS), so the auto-apply
-- re-run on each deploy is a no-op.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS trgm_mfg_so_debtor_name
  ON scm.mfg_sales_orders USING gin (debtor_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS trgm_mfg_so_phone
  ON scm.mfg_sales_orders USING gin (phone gin_trgm_ops);
