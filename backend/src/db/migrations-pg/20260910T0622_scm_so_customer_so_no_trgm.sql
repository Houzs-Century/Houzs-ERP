-- 20260910T0622_scm_so_customer_so_no_trgm.sql
-- pg_trgm GIN index on scm.mfg_sales_orders.customer_so_no.
--
-- The SO list free-text search (src/scm/routes/mfg-sales-orders.ts) probes the
-- reference the list DISPLAYS. That reference is customerRefOf = ref ||
-- customer_so_no, and customer_so_no was added to the search `.or()` in this PR
-- (bug 0755: an order carrying its reference only in customer_so_no rendered it
-- on screen yet could not be found by it). Every other column searched on this
-- table already carries a trigram index (doc_no / debtor_name / debtor_code /
-- agent / sales_location / ref / branding / phone — confirmed live 2026-09-10);
-- this adds the one the new predicate needs, so a substring ILIKE stays an index
-- scan instead of a sequential scan on every keystroke.
--
-- Idempotent (IF NOT EXISTS); pg_trgm is already enabled (the sibling indexes
-- use gin_trgm_ops).
--
-- REVERSAL: DROP INDEX IF EXISTS scm.trgm_mfg_so_customer_so_no;

CREATE INDEX IF NOT EXISTS trgm_mfg_so_customer_so_no
  ON scm.mfg_sales_orders USING gin (customer_so_no gin_trgm_ops);
