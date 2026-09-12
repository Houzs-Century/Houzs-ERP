-- 20260912T0130 — Re-grant SELECT on scm.mfg_sales_orders_with_payment_totals
-- to every role that reads it, self-adapting, and SAY what was granted.
--
-- WHY. The staging Sales Orders list has answered "Failed to load — permission
-- denied for view mfg_sales_orders_with_payment_totals" on every nightly
-- rehearsal since 2026-08-21 (docs/bugs/0825; the Playwright screenshot on run
-- 34627320170 is the observation). Production serves the same list from the
-- same view without error, so the grantee set differs between the two
-- databases. The three recreations since 0191 (0325, 20260909T1001,
-- 20260911T1500) all used CREATE OR REPLACE, which keeps the ACL — so the
-- staging ACL was already short of the role its runtime reads with, and 0191's
-- copy-from-sibling could only copy what the sibling held THERE.
--
-- WHAT. Same shape as 0191, widened: copy the sibling's SELECT grantees and
-- owner onto the view; grant service_role outright (PostgREST's role, the one
-- the SO list route uses via supabase-js); grant every role whose name starts
-- with `hyperdrive` if it exists (the Hyperdrive origin roles are named in
-- Cloudflare connection strings, not in this repo — 0191's lesson: do not
-- guess a single name). Idempotent: GRANT and ALTER OWNER re-run as no-ops.
-- Every step RAISEs the grantee list before and after, so the staging-migrate
-- log IS the evidence of what changed, on each database, with no hand query.
--
-- REVERSAL: none needed — additive grants only; REVOKE the same list if ever
-- required. No data touched.
-- Verified against: staging via staging-migrate.yml on merge (the NOTICE lines
-- in its log), production via deploy.yml's pg-migrate step (same lines).
-- RE-RUN: no-op — every GRANT/ALTER OWNER is idempotent.

DO $$
DECLARE
  g record;
  before_list text;
  after_list text;
  sibling_owner text;
BEGIN
  SELECT string_agg(grantee, ', ' ORDER BY grantee) INTO before_list
    FROM information_schema.role_table_grants
   WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders_with_payment_totals'
     AND privilege_type = 'SELECT';
  RAISE NOTICE 'payment-totals view SELECT grantees BEFORE: %', coalesce(before_list, '(none)');

  -- 1) Copy the never-dropped sibling's SELECT grantees (0191's self-adapting rule).
  FOR g IN
    SELECT DISTINCT grantee
      FROM information_schema.role_table_grants
     WHERE table_schema = 'scm' AND table_name = 'suppliers_with_derived_category'
       AND privilege_type = 'SELECT' AND grantee <> 'PUBLIC'
  LOOP
    EXECUTE format('GRANT SELECT ON scm.mfg_sales_orders_with_payment_totals TO %I', g.grantee);
  END LOOP;

  -- 2) The PostgREST role the SO list route reads through (supabase-js, service key).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON scm.mfg_sales_orders_with_payment_totals TO service_role;
  END IF;

  -- 3) Every Hyperdrive origin role present on THIS database, whatever it is called.
  FOR g IN SELECT rolname AS grantee FROM pg_roles WHERE rolname LIKE 'hyperdrive%' LOOP
    EXECUTE format('GRANT SELECT ON scm.mfg_sales_orders_with_payment_totals TO %I', g.grantee);
  END LOOP;

  -- 4) A view resolves its base tables with its OWNER's privileges: match the sibling.
  SELECT viewowner INTO sibling_owner FROM pg_views
   WHERE schemaname = 'scm' AND viewname = 'suppliers_with_derived_category';
  IF sibling_owner IS NOT NULL THEN
    EXECUTE format('ALTER VIEW scm.mfg_sales_orders_with_payment_totals OWNER TO %I', sibling_owner);
  END IF;

  SELECT string_agg(grantee, ', ' ORDER BY grantee) INTO after_list
    FROM information_schema.role_table_grants
   WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders_with_payment_totals'
     AND privilege_type = 'SELECT';
  RAISE NOTICE 'payment-totals view SELECT grantees AFTER: % (owner %)', coalesce(after_list, '(none)'), coalesce(sibling_owner, '(unchanged)');
END $$;
