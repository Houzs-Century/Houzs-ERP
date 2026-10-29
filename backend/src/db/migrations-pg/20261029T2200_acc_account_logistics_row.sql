-- 20261029T2200_acc_account_logistics_row.sql
-- REVERSAL: revert the code first (scm/lib/logistics-rows.ts and its readers: the
--   Chart of Accounts' Logistics column, the Logistics P&L and the Logistics cost
--   report). Then:
--     ALTER TABLE scm.accounts DROP COLUMN IF EXISTS logistics_row;
--   Finance's picks are lost; no journal entry depends on them.
--   GRANTS: none — a column on an existing table rides that table's grants.
-- Verified against: PENDING — the production rehearsal is named here before merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- nullable column on scm.accounts with a CHECK, and the row each account feeds
-- TODAY written onto the 38 codes the Logistics P&L reads — only this new column
-- on those rows, nothing else.
--
-- WHY (owner 2026-10-29): the Logistics cost page's own-lorry tick list —
-- 「这样显示很丑，就不能在coa 那边tick？」 → a Logistics column on the Chart of
-- Accounts, one row per account like the PMS row (「可以」), so one amount can
-- never land in two rows. Until now the P&L found its accounts by their names
-- (TRANSPORT (PNG …), PETROL … LORI, HP CREDITOR - <our plate>, TRANSPORT INCOME
-- (…)) and the cost report by the own-lorry list (the chart's default — no
-- company ever ticked its own). The values below are exactly what those rules give
-- today (backend/scripts/check-logistics-rows.mjs, run-script.yml run 40876313449,
-- 2026-10-29: no code gets different rows in different companies), less two:
--   • 900-U006 UPKEEP OF LORI — a header; it takes no money;
--   • 590-0000 TRANSPORT INCOME — no region in its name, and a sales invoice's
--     transport income 「另有用途」; Other Debtor transport bills go on
--     590-0001 … 590-0004, and no Other Debtor line sits on 590-0000.
-- A definition field: every company carrying the code takes the same value.

SET search_path = public, scm;

ALTER TABLE scm.accounts
  ADD COLUMN IF NOT EXISTS logistics_row text CHECK (logistics_row IS NULL OR logistics_row IN (
    'outsource_pg', 'outsource_kl', 'outsource_em', 'outsource_sg',
    'petrol', 'upkeep', 'other_lorry', 'instalment', 'roadtax',
    'income_pg', 'income_kl', 'income_em', 'income_sg'));

UPDATE scm.accounts SET logistics_row = 'outsource_pg' WHERE account_code = '900-T005';
UPDATE scm.accounts SET logistics_row = 'outsource_kl' WHERE account_code = '900-T006';
UPDATE scm.accounts SET logistics_row = 'outsource_em'
  WHERE account_code IN ('900-T007', '900-T017', '900-T018', '900-T019', '900-T020', '900-T021',
                         '900-T022', '900-T023', '900-T024', '900-T025', '900-T026', '900-T036');
UPDATE scm.accounts SET logistics_row = 'outsource_sg'
  WHERE account_code IN ('900-T015', '900-T027', '900-T028', '900-T029', '900-T034');
UPDATE scm.accounts SET logistics_row = 'petrol'
  WHERE account_code IN ('900-P006', '900-P007', '900-P009', '900-P010', '900-P014', '900-P015');
UPDATE scm.accounts SET logistics_row = 'upkeep'
  WHERE account_code IN ('900-U007', '900-U008', '900-U009', '900-U010', '900-U011');
UPDATE scm.accounts SET logistics_row = 'instalment'
  WHERE account_code IN ('450-H002', '450-H003', '450-H005');
UPDATE scm.accounts SET logistics_row = 'roadtax' WHERE account_code = '900-I002';
UPDATE scm.accounts SET logistics_row = 'income_pg' WHERE account_code = '590-0001';
UPDATE scm.accounts SET logistics_row = 'income_kl' WHERE account_code = '590-0002';
UPDATE scm.accounts SET logistics_row = 'income_em' WHERE account_code = '590-0003';
UPDATE scm.accounts SET logistics_row = 'income_sg' WHERE account_code = '590-0004';
