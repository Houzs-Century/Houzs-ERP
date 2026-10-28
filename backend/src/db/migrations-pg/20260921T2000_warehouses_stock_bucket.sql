-- 20260921T2000_warehouses_stock_bucket.sql
-- REVERSAL: ALTER TABLE scm.warehouses DROP COLUMN IF EXISTS stock_bucket; — the column is new
--   and nullable; the two rows this file sets fall back to their type's default (display /
--   others) once it is gone, and the next stock close re-posts on that reading. Nothing
--   else is altered. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NULLABLE COLUMN on scm.warehouses with a CHECK on its three values, and
-- TWO rows of company 1 set to 'customer'. The deployed application keeps
-- working whether or not this has run: a NULL means "by type", which is what
-- every warehouse reads today; the route that writes it ships in the same PR.
--
-- WHY IT EXISTS (owner 2026-09-21: stock 那边我要分三个东西, closing stock -
-- customer / display / service; cash & carry segment 算顾客的). The month-end
-- stock close now books three closing stocks, one per bucket, and the bucket
-- comes from the warehouse: its TYPE by default (warehouse, others → customer;
-- showroom, display → display; service → service) or this override where the
-- type says one thing and the business another — HOUZS's two Cash & Carry
-- segment locations are typed display / others and hold goods for sale.

SET search_path = public, scm;

ALTER TABLE scm.warehouses
  ADD COLUMN IF NOT EXISTS stock_bucket text
  CHECK (stock_bucket IS NULL OR stock_bucket IN ('customer', 'display', 'service'));

UPDATE scm.warehouses
   SET stock_bucket = 'customer'
 WHERE company_id = 1 AND code IN ('C&C DISPLAY', 'C&C K.J') AND stock_bucket IS NULL;
