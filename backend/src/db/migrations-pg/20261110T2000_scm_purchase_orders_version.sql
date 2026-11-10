-- 20261110T2000_scm_purchase_orders_version.sql
-- REVERSAL: ALTER TABLE scm.purchase_orders DROP COLUMN IF EXISTS version;
--   Revert the code first: routes/mfg-purchase-orders.ts PATCH /:id selects and
--   compare-and-sets this column (lib/po-version.ts). With the code reverted the
--   column is unread and dropping it loses nothing but the counter.
--   GRANTS: none to restore (a column add/drop does not touch the table ACL).
--
-- WHAT THIS CHANGES: one integer column on scm.purchase_orders, NOT NULL
-- DEFAULT 1, so every existing PO reads version 1 until its next header save.
-- Same shape as 0153_scm_mfg_sales_orders_version.sql, the Sales Order's.
--
-- WHY (sister review G6 follow-up to #5551). The PO header PATCH refuses a save
-- whose screen is older than the row (the `updated_at` it loaded), but that
-- compare runs in code against a row read just before the write, so two Saves
-- landing within the same few milliseconds both passed it and the later one
-- silently put back the other's values. The PATCH now writes
-- `version = v + 1 WHERE version = v`, so the database lets exactly one of two
-- concurrent Saves through.
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; no inner BEGIN/COMMIT.

ALTER TABLE scm.purchase_orders
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
