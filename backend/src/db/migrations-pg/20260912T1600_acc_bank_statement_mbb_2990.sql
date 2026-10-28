-- 20260912T1600_acc_bank_statement_mbb_2990.sql
-- REVERSAL: DELETE FROM scm.acc_bank_statement_config WHERE company_id = 2 AND account_code = '310-0010' AND bank_code = 'MBB';
--   One data row, no DDL. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   ONE bank-statement config for company 2 — 2990 HOME's Maybank current
--   account 564418610346 is chart account 310-0010 (CASH AT BANK - MAYBANK).
--   The table held only the Hong Leong row (310-0020, migration 20260908T2100),
--   so /scm/bank-recon could take no Maybank file. Guarded by NOT EXISTS on
--   (company, account); the chart row must exist. Company 2 only, by id;
--   HOUZS (company 1) untouched.
--
-- WHY (owner 2026-09-12: maybank statement 要做，我要测试 maybank statement;
-- docs/bugs/0840). Maybank's Account Activity Report export
-- (ACCOUNTACTIVITYREPORT_<account>.csv) is nothing like Hong Leong's: pipe
-- delimited, amounts as integer sen zero-padded to 15 digits
-- (000000000171000 = RM 1,710.00), the direction in its own AMOUNT IND column
-- (CR / DR), dates packed as YYYYMMDD — the shape acc/bank-parse.ts already
-- reads (its Maybank fixture is copied from the real file, pipe for pipe:
-- BATCH DATE | ACCOUNT NO. | PROD TYPE | EFFECT DATE | EFFECT TIME | BRANCH |
-- TELLER | CODE | SOURCE CODE | AMOUNT | AMOUNT IND | TRX DESCRIPTION |
-- TRX REFERENCE | STD REF IND | STD REF1..3 | FILLER1..5). The column map
-- names those captions; the reader's built-in synonyms still cover a
-- re-captioned export. The upload checks the file mentions the account
-- number by its digits, so the zero-padded 0000564418610346 in the file
-- satisfies 564418610346 here.
--
-- Reversal / Verified against: in the PR body, where the check reads them.

SET search_path = scm, public;

INSERT INTO scm.acc_bank_statement_config
  (company_id, account_code, bank_code, account_no, statement_format, delimiter, amount_format, credit_indicator, column_map, is_active)
SELECT 2, '310-0010', 'MBB', '564418610346', 'CSV', '|', 'integer-sen', 'CR',
       '{
          "date":        ["EFFECT DATE", "BATCH DATE"],
          "description": ["TRX DESCRIPTION"],
          "reference":   ["TRX REFERENCE"],
          "amount":      ["AMOUNT"],
          "indicator":   ["AMOUNT IND"]
        }'::jsonb,
       TRUE
WHERE EXISTS (SELECT 1 FROM scm.accounts a WHERE a.company_id = 2 AND a.account_code = '310-0010')
  AND NOT EXISTS (SELECT 1 FROM scm.acc_bank_statement_config x WHERE x.company_id = 2 AND x.account_code = '310-0010');
