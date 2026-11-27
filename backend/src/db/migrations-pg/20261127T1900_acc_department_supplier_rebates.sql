-- 20261127T1900_acc_department_supplier_rebates.sql
--
-- WHY. Owner 2026-11-27: his supplier's rebates — a sponsor rebate and a sales
-- rebate by tier, both on what the company buys from it — estimated month by month
-- in the selling department's own P&L, Performance only (「其实这个是用在department
-- 的 performance exhibition department 罢了」, Houzs only). The terms are commercial
-- and this repository is public, so they are typed by Finance once on the
-- Department P&L (「做设定框」) and kept here, never written into the code.
--
-- WHAT THIS CHANGES: one nullable jsonb column, scm.acc_department_settings
-- .supplier_rebates — a list of rules (scm/lib/supplier-rebates.ts): the supplier's
-- code, a label, the sponsor rate and the products and accessories it leaves out,
-- the sales tiers, the display discount rate. null = none. No company gets a rule
-- here. Read by scm/routes/acc-departments.ts; written by PUT /departments/rebates.
--
-- Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.acc_department_settings DROP COLUMN IF EXISTS supplier_rebates;
--   Revert the code first (scm/routes/acc-departments.ts reads and writes it). No
--   journal entry depends on it. GRANTS: none — a column on an existing table rides
--   its grants.

SET search_path = public, scm;

ALTER TABLE scm.acc_department_settings ADD COLUMN IF NOT EXISTS supplier_rebates jsonb;

NOTIFY pgrst, 'reload schema';
