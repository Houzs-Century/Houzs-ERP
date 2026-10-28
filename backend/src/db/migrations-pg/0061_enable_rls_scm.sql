-- 0061_enable_rls_scm.sql
--
-- Closes the prod RLS gap surfaced by Supabase MCP's database advisory: 119
-- tables under the scm.* schema had Row Level Security disabled.
--
-- Why this matters
--   The Supabase REST endpoint exposes every schema in the database under
--   the anon and authenticated roles by default. Without RLS on a table,
--   anyone holding the project's anon key could call e.g.
--     POST /rest/v1/scm.mfg_sales_orders?select=*
--   and read or write every row — bypassing the Worker's auth + RBAC
--   middleware entirely. Today the frontend never uses supabase-js (every
--   call goes through the Worker, which uses SUPABASE_SERVICE_ROLE_KEY),
--   so the actual exposure is theoretical. But:
--     · the anon key is baked into client bundles and can be leaked
--     · any future dev who reaches for supabase-js to talk to scm.* would
--       silently bypass the Worker's audit + business rules
--
-- What this migration does
--   Enables Row Level Security on every scm.* table that didn't already
--   have it. NO policies are created — that means anon and authenticated
--   are blocked from every row. Postgres service_role bypasses RLS as a
--   built-in convention, so the Worker (which uses the service key in
--   middleware/auth.ts's createClient call) keeps reading + writing
--   everything unchanged. A later PR can layer scoped policies on top if
--   the app ever needs direct supabase-js access to specific tables.
--
-- The DO block lets us re-run this idempotently — it only flips tables
-- still missing RLS, so applying twice is a no-op. Wrapped in pg-migrate's
-- own transaction.
--
-- DOWN (run manually if reverting):
--   DO $$ DECLARE r RECORD; BEGIN
--     FOR r IN SELECT n.nspname, c.relname FROM pg_class c
--              JOIN pg_namespace n ON n.oid=c.relnamespace
--              WHERE n.nspname='scm' AND c.relkind='r' AND c.relrowsecurity
--     LOOP EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.nspname, r.relname);
--     END LOOP;
--   END $$;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'scm'
      AND c.relkind = 'r'
      AND NOT c.relrowsecurity
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.nspname, r.relname);
  END LOOP;
END $$;
