-- REVERSAL: additive only. ALTER TABLE scm.accounts DROP COLUMN acc_money;
-- DELETE FROM scm.accounts WHERE account_code = '946-0000';
-- DELETE FROM scm.acc_account_roles WHERE role = 'OVER_SHORT';
--
-- acc_daily_bank — phase 2B: which chart accounts ARE money (the Daily Bank
-- board's blocks), and the over/short account the daily cashup posts
-- differences into (brief §3.5 layer 2: a count that does not match books the
-- difference, it never papers over it).
-- NOTE: number re-checked against the tree at merge time.

-- 1. Money flag: the accounts the Daily Bank board shows as blocks. A master
--    flag, not a name heuristic - renaming a bank must not drop it off the
--    board. New bank/cash accounts opt in via the chart UI later.
ALTER TABLE scm.accounts ADD COLUMN acc_money BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE scm.accounts SET acc_money = TRUE
WHERE account_code IN ('330-0000', '331-0000', '335-0000');

-- 2. Cash over/short, both companies, under Operating Expense.
INSERT INTO scm.accounts (account_code, account_name, account_type, parent_code, is_active, company_id)
SELECT '946-0000', 'Cash Over/Short', 'EXPENSE', '900-0000', TRUE, c.company_id
FROM (VALUES (1), (2)) AS c(company_id)
WHERE NOT EXISTS (
  SELECT 1 FROM scm.accounts a WHERE a.company_id = c.company_id AND a.account_code = '946-0000'
);

INSERT INTO scm.acc_account_roles (company_id, role, account_code) VALUES
  (1, 'OVER_SHORT', '946-0000'),
  (2, 'OVER_SHORT', '946-0000')
ON CONFLICT (company_id, role) DO NOTHING;
