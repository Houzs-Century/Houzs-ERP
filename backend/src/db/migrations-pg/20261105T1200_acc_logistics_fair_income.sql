-- 20261105T1200_acc_logistics_fair_income.sql
-- REVERSAL: revert the code first (the Logistics P&L's "Transport Income (1% of
--   fair sales)" row and its PUT /acc-events/logistics/fair-income-rate). Then:
--     ALTER TABLE scm.acc_logistics_settings DROP CONSTRAINT IF EXISTS acc_logistics_settings_fair_income_bp_check;
--     ALTER TABLE scm.acc_logistics_settings DROP COLUMN IF EXISTS fair_income_bp;
--   Finance's own rate is lost; the code's default (1%) reads again.
--   GRANTS: none to re-apply — the table rides the scm schema's default
--   privileges (service_role); this file grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- column with a default on the small per-company settings table. Nothing
-- existing is read, written or altered.
--
-- WHY (owner 2026-11-05): the Logistics P&L counts 1% of each fair's sales as
-- Transport Income, like the DO's 3% — a rate Finance keeps (100 = 1%).

ALTER TABLE scm.acc_logistics_settings
  ADD COLUMN IF NOT EXISTS fair_income_bp integer NOT NULL DEFAULT 100;
ALTER TABLE scm.acc_logistics_settings DROP CONSTRAINT IF EXISTS acc_logistics_settings_fair_income_bp_check;
ALTER TABLE scm.acc_logistics_settings
  ADD CONSTRAINT acc_logistics_settings_fair_income_bp_check CHECK (fair_income_bp BETWEEN 0 AND 10000);

NOTIFY pgrst, 'reload schema';
