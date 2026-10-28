-- 0054_restore_is_active_defaults.sql
-- The D1 -> Postgres migration dropped the `DEFAULT 1` on several is_active
-- columns (active rows that omit the column landed NULL, so `is_active` filters
-- silently excluded them / NOT NULL inserts 500'd). All four columns are bigint.
-- Restore the default so inserts that omit the column behave as before.
--
-- Idempotent — re-setting the same default is a no-op. Applied to prod manually
-- on 2026-06-26; this file keeps fresh Postgres environments + the _pg_migrations
-- tracker in sync. Moved here from migrations/104 (the SQLite test mirror), which
-- rejects this Postgres-only `ALTER COLUMN … SET DEFAULT` syntax.
ALTER TABLE public.assr_lead_time_profiles ALTER COLUMN is_active SET DEFAULT 1;
ALTER TABLE public.creditors               ALTER COLUMN is_active SET DEFAULT 1;
ALTER TABLE public.lorries                 ALTER COLUMN is_active SET DEFAULT 1;
ALTER TABLE public.stock_items             ALTER COLUMN is_active SET DEFAULT 1;
