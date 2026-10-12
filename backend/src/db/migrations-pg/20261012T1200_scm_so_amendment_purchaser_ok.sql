-- 20261012T1200_scm_so_amendment_purchaser_ok.sql
-- REVERSAL:
--   ALTER TABLE scm.so_amendments DROP COLUMN IF EXISTS purchaser_ok_at;
--   ALTER TABLE scm.so_amendments DROP COLUMN IF EXISTS purchaser_ok_by;
--   Both columns are new and nullable; dropping them loses only WHO gave the
--   Purchaser OK and when. The AMENDMENT_PURCHASER_OK history row on the Sales
--   Order keeps the same facts. GRANTS: none touched — ALTER TABLE keeps the ACL.
--
-- WHAT THIS IS FOR (BUG-101, owner 2026-10-12). Bringing a Delivery Date
-- FORWARD on an order that already has a live Purchase Order asks the supplier
-- for the goods sooner, so it needs the Purchaser as well as Logistic. The
-- request stays ONE Logistic-lane amendment; the Purchaser's OK is a step on it
-- that the Logistic approve refuses to run without (shared/so-po-date-rule.ts).
-- Postponing stays Logistic's alone and never reads these columns.
--
--   so_amendments.purchaser_ok_by   scm.staff uuid of the Purchaser who OK'd it
--   so_amendments.purchaser_ok_at   when
SET search_path = scm, public;

ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS purchaser_ok_by uuid;
ALTER TABLE scm.so_amendments ADD COLUMN IF NOT EXISTS purchaser_ok_at timestamptz;
