-- 20261102T1500_scm_dp_orders_origin.sql
-- A TRANSFER DP order can record its ORIGIN ("from where"), not only the
-- destination (owner 2026-11-02, 方案1): a partner / 3PL delivery is "from A to
-- B", and until now only B (the party / destination) was captured.
--
-- WHY. dp_orders snapshots ONE party — the destination (mig 0129 + 20261102T1300
-- for the 3PL destination). The loading point was implicit (the trip's depot), so
-- a job that goes from one place to another could not say where it starts. These
-- columns hold the origin the operator picks the same way as the destination: our
-- own warehouse, an outsourced 3PL, or typed. The address is the pickup point the
-- driver loads from.
--
-- from_warehouse_id / from_threepl_company_id are the soft provenance links (bare
-- columns, no FK — the same decision 0129 / 0251 / 20261102T1300 made: they cross
-- to masters that may be tidied up, and a DP order must survive that). The origin
-- is OPTIONAL — only a transfer that actually moves between two chosen points
-- fills it; every other job and an ordinary depot-loaded transfer leave it null.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill (no existing
-- row carried an origin). RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.dp_orders
--     DROP COLUMN IF EXISTS from_name,
--     DROP COLUMN IF EXISTS from_address1,
--     DROP COLUMN IF EXISTS from_address2,
--     DROP COLUMN IF EXISTS from_city,
--     DROP COLUMN IF EXISTS from_postcode,
--     DROP COLUMN IF EXISTS from_state,
--     DROP COLUMN IF EXISTS from_warehouse_id,
--     DROP COLUMN IF EXISTS from_threepl_company_id;

ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_name              text;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_address1          text;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_address2          text;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_city              text;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_postcode          text;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_state             text;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_warehouse_id      uuid;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_threepl_company_id uuid;
