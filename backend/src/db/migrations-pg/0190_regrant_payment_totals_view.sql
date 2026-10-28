-- 0190 — Re-grant SELECT on scm.mfg_sales_orders_with_payment_totals.
--
-- INCIDENT (2026-07-24 evening). The Sales Orders list on prod failed for every
-- user with "permission denied for view mfg_sales_orders_with_payment_totals"
-- (surfaced by the owner on the dev proxy, which reads prod). Root cause: 0189
-- rightly used DROP VIEW -> DROP COLUMN -> CREATE VIEW to retire
-- processing_date (a bare DROP COLUMN is refused while the view projects it),
-- but a re-created view is a NEW object: DROP discards the old object's ACL,
-- and nothing re-granted it. The original grant lived in 0084
-- (GRANT SELECT ... TO service_role) and silently died with the old view.
--
-- LESSON for every future DROP VIEW -> CREATE VIEW cycle: the recreate is not
-- done until the grants from the previous life of the view are re-applied.
--
-- Idempotent: GRANT is additive and safe to re-run; the DO block no-ops where
-- the staging-only role does not exist (prod). The staging E2E smoke failure on
-- 0647b201 is consistent with staging losing the same SELECT, hence the guarded
-- staging grant alongside the prod one.

GRANT SELECT ON scm.mfg_sales_orders_with_payment_totals TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyperdrive_staging') THEN
    GRANT SELECT ON scm.mfg_sales_orders_with_payment_totals TO hyperdrive_staging;
  END IF;
END $$;
