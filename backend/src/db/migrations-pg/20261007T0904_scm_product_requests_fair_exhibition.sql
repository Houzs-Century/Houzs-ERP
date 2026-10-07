-- 20261007T0904_scm_product_requests_fair_exhibition.sql
-- REVERSAL: ALTER TABLE scm.product_requests DROP CONSTRAINT IF EXISTS product_requests_application_check;
--   ALTER TABLE scm.product_requests ADD CONSTRAINT product_requests_application_check
--     CHECK (application IN ('SHOWROOM', 'CUSTOMER_ORDER', 'SAMPLE'));
--   Revert the code first (shared/product-request.ts PRODUCT_REQUEST_APPLICATIONS and
--   the frontend APPLICATION_LABEL) and re-point any FAIR_EXHIBITION row to another
--   application, or the narrower check refuses to attach.
--   GRANTS: none to re-apply — a constraint rides its table's grants.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: the CHECK on
-- scm.product_requests.application gains one allowed value. Every existing row
-- already satisfies the wider check; no row is written. The old check was declared
-- inline (20261006T0741), so Postgres named it; it is found in the catalogue by
-- what it checks rather than assumed by name, and re-added under the explicit name.
-- The DO block is ONE line because pg-migrate splits on ";\n" and does not see $$.
--
-- WHY (owner 2026-10-07: 多加一个 Fair Exhibition): a product asked for a fair
-- booth is a fourth use beside showroom, customer order and sample.

DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'scm.product_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%application%' LOOP EXECUTE format('ALTER TABLE scm.product_requests DROP CONSTRAINT %I', c.conname); END LOOP; END $$;
ALTER TABLE scm.product_requests ADD CONSTRAINT product_requests_application_check
  CHECK (application IN ('SHOWROOM', 'CUSTOMER_ORDER', 'SAMPLE', 'FAIR_EXHIBITION'));
