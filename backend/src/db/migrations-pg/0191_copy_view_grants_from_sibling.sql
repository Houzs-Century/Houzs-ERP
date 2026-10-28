-- 0191 — Copy the FULL grant set (and owner) onto the recreated payment-totals
-- view from its never-dropped sibling.
--
-- WHY 0190 WAS NOT ENOUGH. 0190 re-granted SELECT to service_role (the grant
-- 0084 wrote) and deployed clean, yet prod still failed with "permission denied
-- for view mfg_sales_orders_with_payment_totals" — verified live after the 0190
-- deploy. Conclusion: the role the prod runtime actually queries the view with
-- is NOT (only) service_role; the production connection runs through Hyperdrive
-- with its own database role, whose name lives in the Cloudflare connection
-- string and appears nowhere in this repo. Guessing role names in migrations is
-- how 0190 missed — so stop guessing.
--
-- THE SELF-ADAPTING FIX. scm.suppliers_with_derived_category was created in the
-- SAME migration as the original payment-totals view (0084) and has never been
-- dropped since, so its catalog ACL still holds the exact set of grantees the
-- payment-totals view had before 0189 recreated it (service_role, the prod
-- Hyperdrive role, anything else granted since). Copy that sibling's SELECT
-- grantee list — and its owner, since a view resolves its base tables with the
-- OWNER's privileges — onto the recreated view. Idempotent: GRANT and ALTER
-- OWNER TO the same values re-run as no-ops.

DO $$
DECLARE
  g record;
  sibling_owner text;
BEGIN
  FOR g IN
    SELECT DISTINCT grantee
    FROM information_schema.role_table_grants
    WHERE table_schema = 'scm'
      AND table_name = 'suppliers_with_derived_category'
      AND privilege_type = 'SELECT'
      AND grantee <> 'PUBLIC'
  LOOP
    EXECUTE format(
      'GRANT SELECT ON scm.mfg_sales_orders_with_payment_totals TO %I',
      g.grantee
    );
  END LOOP;

  SELECT viewowner INTO sibling_owner
  FROM pg_views
  WHERE schemaname = 'scm' AND viewname = 'suppliers_with_derived_category';

  IF sibling_owner IS NOT NULL THEN
    EXECUTE format(
      'ALTER VIEW scm.mfg_sales_orders_with_payment_totals OWNER TO %I',
      sibling_owner
    );
  END IF;
END $$;
