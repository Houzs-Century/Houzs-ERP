-- 20261119T2300_acc_department_pnl.sql
-- REVERSAL: revert the code first (scm/lib/department-rows.ts and its readers: the
--   Chart of Accounts' Department column and the Department P&L). Then:
--     DROP TABLE IF EXISTS scm.acc_department_settings;
--     ALTER TABLE scm.accounts DROP COLUMN IF EXISTS department_row;
--   Finance's picks and rates are lost; no journal entry depends on them.
--   GRANTS: none to re-apply — a column on an existing table rides that table's
--   grants, and the new table rides the scm schema's default privileges
--   (service_role), like scm.acc_logistics_settings; this file grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- nullable column on scm.accounts with a CHECK, written on the expense accounts
-- below (only this new column on those rows, nothing else), and one new, empty
-- settings table under a new name. Nothing existing is read or altered.
--
-- WHY (owner 2026-11-19): a Department P&L — an Operation report (his "Operation
-- PNL - Auto" sheet, Sept26 - Logistic & Operation Cost.xlsx), a G&A report (admin,
-- IT, legal and HQ — his report requirements, §3 Department P&L) and every account
-- split across the departments (「我要可以看全部的，也要可以看单独部门的」).
-- Which department an account's money belongs to is a Department column on the
-- Chart of Accounts, one value per account like the Logistics column: G&A, or an
-- Operation row (the sheet's rows) in one region (Penang / KL / SBH & SWK). The
-- payroll accounts stay blank: the salary journal's team lines decide them
-- (scm/lib/department-rows.ts). The values written below are today's P&L tree:
--   • G&A — the accounts the P&L lays under Salary & related (the director's pay
--     and medical, not the payroll accounts every team shares, not staff
--     commission), Rental - office & others, Homestay, Professional & statutory and
--     Office & admin, less 900-O001 (2990's operation charges paid to Houzs) and
--     900-I002 (the Logistics column's road tax & insurance);
--   • Operation — the P&L's Warehouse expense accounts, each in its sheet row and
--     its warehouse's region.
-- A definition field: every company carrying the code takes the same value.
-- The rates: G&A's share of the Performance sales (8%, his requirements' fixed
-- ratio) and Operation's income from the DOs' value (7%, his sheet), Finance's to change.

SET search_path = public, scm;

ALTER TABLE scm.accounts
  ADD COLUMN IF NOT EXISTS department_row text CHECK (department_row IS NULL OR department_row IN ('ga', 'op_accommodation_pg', 'op_accommodation_kl', 'op_accommodation_em', 'op_rental_pg', 'op_rental_kl', 'op_rental_em', 'op_expenses_pg', 'op_expenses_kl', 'op_expenses_em', 'op_parttime_pg', 'op_parttime_kl', 'op_parttime_em', 'op_upkeep_pg', 'op_upkeep_kl', 'op_upkeep_em', 'op_insurance_pg', 'op_insurance_kl', 'op_insurance_em', 'op_utilities_pg', 'op_utilities_kl', 'op_utilities_em', 'op_telephone_pg', 'op_telephone_kl', 'op_telephone_em'));

UPDATE scm.accounts SET department_row = 'ga' WHERE account_code IN (
  -- Salary & related: the director's pay and staff medical
  '900-D002', '900-D100', '900-D200', '900-D300', '900-D400', '900-D500', '900-M002', '900-S800',
  -- Rental - office & others
  '900-R001', '900-R044', '900-R045', '900-R047',
  -- Homestay, hostel & accommodation
  '900-E010', '900-H002', '900-H005', '900-H011', '900-H012', '900-R011', '900-R012', '900-R013', '900-R014',
  '900-R015', '900-R016', '900-R017', '900-R018', '900-R019', '900-R020', '900-R021', '900-R043', '900-U004',
  -- Professional & statutory
  '900-A001', '900-A011', '900-B002', '900-D005', '900-I001', '900-L001', '900-P003', '900-P011', '900-P013', '900-S002',
  -- Office & admin
  '900-A012', '900-A013', '900-B001', '900-B004', '900-D001', '900-D004', '900-D006', '900-E001', '900-E007', '900-G001',
  '900-I003', '900-L002', '900-P001', '900-P002', '900-P008', '900-P012', '900-S003', '900-S004', '900-S005', '900-S008',
  '900-T001', '900-T003', '900-T010', '900-U002', '900-U012', '900-W001', '900-W002', '900-W003', '900-W006',
  '919-0000', '922-0000', '926-0000', '930-0000', '931-0000', '933-0000', '937-0000', '938-0000', '946-0000', '947-0000'
);

UPDATE scm.accounts SET department_row = 'op_rental_pg' WHERE account_code = '900-R004';
UPDATE scm.accounts SET department_row = 'op_rental_kl' WHERE account_code IN ('900-R003', '900-R005', '900-R042');
UPDATE scm.accounts SET department_row = 'op_rental_em' WHERE account_code = '900-R046';
UPDATE scm.accounts SET department_row = 'op_expenses_pg' WHERE account_code = '900-E013';
UPDATE scm.accounts SET department_row = 'op_expenses_kl' WHERE account_code IN ('900-E009', '900-E012', '900-E014');
UPDATE scm.accounts SET department_row = 'op_accommodation_kl' WHERE account_code = '900-H004';
UPDATE scm.accounts SET department_row = 'op_utilities_pg' WHERE account_code = '900-W008';
UPDATE scm.accounts SET department_row = 'op_utilities_kl' WHERE account_code IN ('900-W007', '900-W009');
UPDATE scm.accounts SET department_row = 'op_telephone_pg' WHERE account_code = '900-T014';
UPDATE scm.accounts SET department_row = 'op_telephone_kl' WHERE account_code = '900-T013';
UPDATE scm.accounts SET department_row = 'op_upkeep_kl' WHERE account_code = '900-U001';

-- One row per company that changed a rate; a company with no row reads the defaults.
CREATE TABLE IF NOT EXISTS scm.acc_department_settings (
  company_id           bigint PRIMARY KEY REFERENCES public.companies (id),
  ga_share_bp          integer NOT NULL DEFAULT 800 CHECK (ga_share_bp BETWEEN 0 AND 10000),
  operation_income_bp  integer NOT NULL DEFAULT 700 CHECK (operation_income_bp BETWEEN 0 AND 10000),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text
);

NOTIFY pgrst, 'reload schema';
