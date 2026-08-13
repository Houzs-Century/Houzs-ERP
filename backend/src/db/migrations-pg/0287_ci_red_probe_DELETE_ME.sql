-- 0287 — deliberate violation: no reversal note. Reverted in the next commit.
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS ci_red_probe text;
