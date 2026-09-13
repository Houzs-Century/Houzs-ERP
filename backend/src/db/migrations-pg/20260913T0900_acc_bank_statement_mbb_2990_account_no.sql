-- 20260913T0900_acc_bank_statement_mbb_2990_account_no.sql
-- REVERSAL: UPDATE scm.acc_bank_statement_config SET account_no = '564418610346' WHERE company_id = 2 AND account_code = '310-0010' AND bank_code = 'MBB' AND account_no = '564418759397';
--   One data row, no DDL. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   The account number on 2990's Maybank statement config (310-0010, seeded
--   by 20260912T1600). That seed took the number off the only Maybank export
--   that had been analysed — ACCOUNTACTIVITYREPORT_564418610346.csv — which
--   is HOUZS's (company 1) account. Owner 2026-09-13: 564418610346 是 houzs 的，
--   2990 的是 564418759397. The upload refuses a file that does not mention
--   the configured number, so with the wrong number every 2990 Maybank file
--   was refused ("This file does not mention account 564418610346").
--   Guarded on the seeded value, so a row the owner has already corrected
--   on the Setup screen is left as it is. Company 2 only, by id.
--
-- Reversal / Verified against: in the PR body, where the check reads them.

SET search_path = scm, public;

UPDATE scm.acc_bank_statement_config
   SET account_no = '564418759397', updated_at = now()
 WHERE company_id = 2 AND account_code = '310-0010' AND bank_code = 'MBB' AND account_no = '564418610346';
