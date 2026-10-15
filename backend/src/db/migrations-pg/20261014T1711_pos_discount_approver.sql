-- 20261014T1711_pos_discount_approver.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Houzs POS build, step 9 (QA item 8: "price override and discount above cap
-- require supervisor PIN; audit log entries exist"). The device already records
-- WHO overrode a price on the line (override_by); this adds WHO passed a manual
-- discount above the cashier's cap, per line and per bill, so the ERP can write
-- the pos_audit rows at sync. Two nullable text columns; no row is touched.
--
-- REVERSAL: ALTER TABLE pos_sale_lines DROP COLUMN discount_by;
--           ALTER TABLE pos_sales DROP COLUMN bill_discount_by. GRANTS: none.
-- Verified against: the migrations-pg tree (both tables from 20261014T1147).

SET search_path = public;

ALTER TABLE pos_sale_lines ADD COLUMN IF NOT EXISTS discount_by TEXT;
ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS bill_discount_by TEXT;
