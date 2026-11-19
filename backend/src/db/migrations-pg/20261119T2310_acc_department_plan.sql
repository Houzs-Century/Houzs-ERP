-- 20261119T2310_acc_department_plan.sql
-- REVERSAL: revert the code first (scm/lib/department-rows.ts — the company plans and
--   the new Department column values). Then:
--     UPDATE scm.accounts SET department_row = NULL
--       WHERE department_row IN ('exhibition', 'showroom', 'logistics', 'operation', 'sales', 'hire');
--     ALTER TABLE scm.accounts DROP CONSTRAINT IF EXISTS accounts_department_row_check;
--     then re-add accounts_department_row_check with the 25 values 20261119T2300 set;
--     ALTER TABLE scm.acc_department_settings DROP COLUMN IF EXISTS plan;
--   Finance's picks of the new values and the two plans are lost; no journal entry depends on them.
--   GRANTS: none — a column on existing tables rides their grants.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: the Department
-- column's CHECK takes six more values (every earlier value stays valid); the new
-- values are written on the expense accounts below (only this column on those rows);
-- one new nullable column on the small settings table, filled for companies 1 and 2.
-- Nothing else is read or altered.
--
-- WHY (owner 2026-11-19): nothing may sit in no department (「不应该有不属于任何部门的」).
-- Houzs has four departments — Exhibition (「这个就是exhibition P&L了」: the fairs, their
-- sales and cost), Operation, Logistics, G&A; its showroom counts in G&A. 2990 has two
-- — Showroom and G&A (「2990只会有showroom和office」): its fairs, operation and logistics
-- count in Showroom. A company's plan says which departments it has, which one sells,
-- and where a nature it has no department for counts.
-- The account values, by nature (his answers the same day):
--   • Exhibition — the P&L's Exhibition & roadshow accounts, the fairs' part-timers too;
--   • Showroom — the Showrooms accounts and 2990's showroom marketing (A009, A015, A016);
--   • G&A — finance cost (「G&A」), general marketing (「先放A」), the online stores'
--     fees (A007, A010), transport not for products (T008: 「不关系到产品的就算G&A」);
--   • Recruitment — the job-ads accounts: each ad by the post it names (Logistic admin,
--     warehouse → Operation: 「这两个是operation吧」; sales → the selling department);
--   • Sales — staff commission (「员工佣金算showroom」, 2990's selling department), event
--     commission and referral fees;
--   • Operation — 2990's operation charges paid to Houzs (900-O001).
-- The payroll accounts stay blank: their team lines decide, a line naming none counts
-- for the selling department (2990's "GROSS SALARY" is its showroom staff).

SET search_path = public, scm;

ALTER TABLE scm.accounts DROP CONSTRAINT IF EXISTS accounts_department_row_check;
ALTER TABLE scm.accounts ADD CONSTRAINT accounts_department_row_check
  CHECK (department_row IS NULL OR department_row IN ('ga', 'op_accommodation_pg', 'op_accommodation_kl', 'op_accommodation_em', 'op_rental_pg', 'op_rental_kl', 'op_rental_em', 'op_expenses_pg', 'op_expenses_kl', 'op_expenses_em', 'op_parttime_pg', 'op_parttime_kl', 'op_parttime_em', 'op_upkeep_pg', 'op_upkeep_kl', 'op_upkeep_em', 'op_insurance_pg', 'op_insurance_kl', 'op_insurance_em', 'op_utilities_pg', 'op_utilities_kl', 'op_utilities_em', 'op_telephone_pg', 'op_telephone_kl', 'op_telephone_em', 'exhibition', 'showroom', 'logistics', 'operation', 'sales', 'hire'));

UPDATE scm.accounts SET department_row = 'exhibition' WHERE account_code IN (
  '900-A003', '900-A008', '900-B003', '900-B005', '900-E002', '900-E004', '900-E005', '900-E006', '900-E011', '900-H003',
  '900-L003', '900-R031', '900-R032', '900-S011', '900-T002', '900-T030', '900-T031', '900-T032', '900-T033', '900-T035'
);
UPDATE scm.accounts SET department_row = 'showroom' WHERE account_code IN (
  '900-A006', '900-A009', '900-A014', '900-A015', '900-A016', '900-C002', '900-E008', '900-R007', '900-R008', '900-R009',
  '900-R048', '900-S001', '900-T012', '900-U003', '900-W005'
);
UPDATE scm.accounts SET department_row = 'ga' WHERE account_code IN (
  '900-A007', '900-A010', '900-M001', '900-T008', '900-H015', '900-L004', '900-T009'
);
UPDATE scm.accounts SET department_row = 'hire' WHERE account_code IN ('900-A004', '900-A005');
UPDATE scm.accounts SET department_row = 'sales' WHERE account_code IN ('900-S700', '900-C003', '900-R041');
UPDATE scm.accounts SET department_row = 'operation' WHERE account_code = '900-O001';

ALTER TABLE scm.acc_department_settings ADD COLUMN IF NOT EXISTS plan jsonb;

INSERT INTO scm.acc_department_settings (company_id, plan, updated_by)
SELECT c.id, p.plan, 'migration 20261119T2310'
  FROM public.companies c
  JOIN (VALUES
    (1, '{"departments": ["exhibition", "operation", "logistics", "ga"], "selling": "exhibition", "folds": {"showroom": "ga"}}'::jsonb),
    (2, '{"departments": ["showroom", "ga"], "selling": "showroom", "folds": {"exhibition": "showroom", "operation": "showroom", "logistics": "showroom"}}'::jsonb)
  ) AS p (company_id, plan) ON p.company_id = c.id
ON CONFLICT (company_id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now(), updated_by = EXCLUDED.updated_by;

NOTIFY pgrst, 'reload schema';
