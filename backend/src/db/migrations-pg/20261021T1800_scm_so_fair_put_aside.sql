-- Fair Links: an order Finance or PMS has PUT ASIDE (owner 2026-10-21: 「还有
-- 一些我看了是 service 要 put aside 的」). While set, the order leaves every
-- Fair Links group and the menu's red count; "Bring back" clears it, and so
-- does linking the order to a fair by hand (scm/lib/fair-put-aside.ts). Who
-- did it and when is also in the order's History.
--
-- Two nullable columns, nothing back-filled: no existing order changes.
-- Deliberately NOT added to any shared SO-list view (view-trap): Fair Links
-- reads the base table mfg_sales_orders directly.
-- REVERSAL: ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS fair_put_aside_at, DROP COLUMN IF EXISTS fair_put_aside_by;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS fair_put_aside_at timestamptz;
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS fair_put_aside_by text;
