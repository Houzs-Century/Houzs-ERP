-- 20261125T2000_acc_department_charges.sql
--
-- WHY. Owner 2026-11-25 (「开始做」): the Department P&L in two bases — Actual (by
-- sales invoice) and Performance (by sales order) — with the departments charging
-- each other on the selling department's sales excluding service: G&A 5%, Operation
-- 7% (3% of it passed to Logistics), Setup & dismantle 1% (「是for setup dismantle的
-- logistic的，不是replace booth setup」), and in Performance merchandise 2% in place
-- of the terminal charges. Those four rates are kept already
-- (acc_department_settings.ga_share_bp / operation_income_bp, acc_logistics_settings
-- .do_income_bp / fair_income_bp). This keeps the rest:
--
--   • scm.acc_department_settings.charges — { merchandiseBp, merchandise: [the
--     accounts merchandise stands in for], setupDismantle: [the fair transport
--     accounts the Setup & dismantle branch carries] }; null = none (no merchandise,
--     no branch). Read by scm/routes/acc-departments.ts (department-charges.ts).
--   • Houzs: merchandise 2% (his fair P&L's rate for every brand) in place of
--     900-T009 TERMINAL INTEREST CHARGES; Setup & dismantle carries the TRANSPORT FAIR
--     accounts 900-T030 to 900-T033 (the booth setup, 900-B003, stays the
--     Exhibition's). 2990 has no Logistics department: nothing.
--
-- Additive, idempotent, schema-qualified; one settings value, filled only where
-- none is kept. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.acc_department_settings DROP COLUMN IF EXISTS charges;
--   Revert the code first (scm/routes/acc-departments.ts reads it). No journal
--   entry depends on it. GRANTS: none — a column on an existing table rides its grants.

SET search_path = public, scm;

ALTER TABLE scm.acc_department_settings ADD COLUMN IF NOT EXISTS charges jsonb;

INSERT INTO scm.acc_department_settings (company_id, charges, updated_by)
SELECT c.id,
       '{"merchandiseBp": 200, "merchandise": ["900-T009"], "setupDismantle": ["900-T030", "900-T031", "900-T032", "900-T033"]}'::jsonb,
       'migration 20261125T2000'
  FROM public.companies c
 WHERE c.code = 'HOUZS'
ON CONFLICT (company_id) DO UPDATE SET charges = EXCLUDED.charges, updated_at = now(), updated_by = EXCLUDED.updated_by
 WHERE scm.acc_department_settings.charges IS NULL;

NOTIFY pgrst, 'reload schema';
