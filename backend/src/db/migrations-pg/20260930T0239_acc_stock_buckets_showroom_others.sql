-- 20260930T0239_acc_stock_buckets_showroom_others.sql
-- REVERSAL: ALTER TABLE scm.warehouses DROP CONSTRAINT IF EXISTS warehouses_stock_bucket_check;
--   UPDATE scm.warehouses SET stock_bucket = NULL WHERE stock_bucket IN ('showroom', 'others');
--   ALTER TABLE scm.warehouses ADD CONSTRAINT warehouses_stock_bucket_check
--     CHECK (stock_bucket IS NULL OR stock_bucket IN ('customer', 'display', 'service'));
--   The six accounts are not deleted once a stock close has booked on them (journal lines
--   name them): revert the code first so the close re-posts on the first three buckets, then
--   UPDATE scm.accounts SET is_active = false WHERE account_code IN ('330-0004', '330-0005',
--   '600-0004', '600-0005', '620-0004', '620-0005'). GRANTS: none to re-apply.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on 2026-09-30;
--   the constraint and the six rows per company read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- 1. The CHECK on scm.warehouses.stock_bucket (mig 20260921T2000) accepts two more values,
--    'showroom' and 'others'. It only widens: every row that passed still passes.
-- 2. Six chart accounts in each company whose chart carries the parents: the showroom and
--    others children of STOCK (330-0000), STOCKS AT THE BEGINNING OF YEAR (600-0000) and
--    STOCKS AT THE END OF YEAR (620-0000), each with its parent's type, section and special
--    marker, active, no money flag — the shape backend/scripts/lib/stock-bucket-accounts.mjs
--    builds for all fifteen. ON CONFLICT leaves an existing row exactly as it is.
--
-- WHY (owner 2026-09-30: Inventory - Showroom, Inventory - Others; showroom 和 display 分开).
-- The month-end stock close books one closing stock per warehouse bucket; showroom and others
-- warehouses now book on their own accounts instead of on display / customer. The code that
-- books on them ships in the same PR and runs only after this file (pg-migrate runs before the
-- Worker deploy), and the close refuses to reverse a month whose replacement cannot post.

SET search_path = public, scm;

ALTER TABLE scm.warehouses DROP CONSTRAINT IF EXISTS warehouses_stock_bucket_check;
ALTER TABLE scm.warehouses
  ADD CONSTRAINT warehouses_stock_bucket_check
  CHECK (stock_bucket IS NULL OR stock_bucket IN ('customer', 'display', 'service', 'showroom', 'others'));

INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, is_active, acc_money, special_type, section)
SELECT p.company_id, c.code, c.name, p.account_type, p.account_code, true, false, p.special_type, p.section
  FROM scm.accounts p
  JOIN (VALUES
    ('330-0000', '330-0004', 'STOCK - SHOWROOM'),
    ('330-0000', '330-0005', 'STOCK - OTHERS'),
    ('600-0000', '600-0004', 'STOCKS AT THE BEGINNING OF YEAR - SHOWROOM'),
    ('600-0000', '600-0005', 'STOCKS AT THE BEGINNING OF YEAR - OTHERS'),
    ('620-0000', '620-0004', 'STOCKS AT THE END OF YEAR - SHOWROOM'),
    ('620-0000', '620-0005', 'STOCKS AT THE END OF YEAR - OTHERS')
  ) AS c(parent, code, name) ON c.parent = p.account_code
ON CONFLICT (company_id, account_code) DO NOTHING;
