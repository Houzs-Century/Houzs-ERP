-- Move five tables that one database built in the WRONG schema back to public.
--
-- WHY THIS EXISTS. pg-migrate ran every file on ONE connection, and a plain
-- `SET search_path = scm, public` inside a migration is session-level: it
-- outlives that file's transaction and silently applies to every later file in
-- the same run. A file with no SET of its own and an unqualified
-- `CREATE TABLE x` then lands in scm, not public. Production never hit it for
-- these five because each file deployed in its own run (0235 at 11:22, 0236 at
-- 12:14 on 2026-08-01). Staging caught up in bulk on 2026-08-12 (0235, 0236,
-- 0252 and 0256 within 40 seconds) and again on 2026-08-22 (0288), so there
-- the same files produced scm.table_layouts, scm.assr_case_categories and the
-- three scm.ac_snapshot_* tables. Every reader of these is unqualified, i.e.
-- public, and on 2026-09-25 20260925T0900_table_layouts_company_shared.sql
-- failed on staging with `relation "table_layouts" does not exist` — and kept
-- failing, so 33 later migrations never reached staging (fail-closed).
--
-- Named 20260925T0859 ON PURPOSE: it must sort before 20260925T0900 so the move
-- runs first on a database where that file is still pending. On production all
-- five already live in public and this is a no-op.
--
-- The runner fix is in scripts/pg-migrate.mjs (RESET search_path before every
-- file). Pinned by tests/pgMigrateSearchPathReset.test.ts.
--
-- REVERSAL: none needed; the move only ever runs on a database that had the
-- table in scm and not in public, and ALTER TABLE ... SET SCHEMA carries the
-- indexes and owned sequences with it.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'table_layouts',
    'assr_case_categories',
    'ac_snapshot_runs',
    'ac_snapshot_sales_orders',
    'ac_snapshot_purchase_orders'
  ] LOOP
    IF to_regclass('public.' || t) IS NULL AND to_regclass('scm.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE scm.%I SET SCHEMA public', t);
      RAISE NOTICE 'moved scm.% to public (built under a leaked search_path)', t;
    END IF;
  END LOOP;
END $$;
