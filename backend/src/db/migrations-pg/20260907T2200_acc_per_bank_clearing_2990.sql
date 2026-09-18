-- 20260907T2200_acc_per_bank_clearing_2990.sql
-- REVERSAL: UPDATE scm.acc_company_acquirers SET transit_account_code = '326-0000', updated_at = now() WHERE company_id = 2 AND acquirer_code IN ('PBB','MBB','GHL','HLB'); DELETE FROM scm.accounts a WHERE a.company_id = 2 AND a.account_code IN ('326-0010','326-0020','326-0030','326-0040') AND NOT EXISTS (SELECT 1 FROM scm.journal_entry_lines l JOIN scm.journal_entries j ON j.id = l.journal_entry_id WHERE j.company_id = 2 AND l.account_code = a.account_code);
--   (an account a journal line already names stays — a posted line must keep
--   its address; re-point the acquirer and leave the account inactive instead.)
--   GRANTS: none to re-apply — data rows only.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Four new ACCOUNT rows for company 2 (2990) and four UPDATEs of company 2's
--   acquirer links. No journal is touched. Prod pre-check (read-only,
--   2026-09-07): company 2 has ZERO journal lines on any 326-* account and no
--   326-0010..0040 rows, so nothing historical needs moving.
--
-- WHY (owner 2026-09-07: 我想要拆账户，因为这样我比较然后检查回 — one clearing
-- account per card machine, so Daily Bank and the ledger say what each bank
-- still owes). Until now every acquirer's card money sat in ONE account,
-- 326-0000 CARD MACHINE CLEARING (EDC), and the board could only say "the
-- machines owe RM X" as a lump.
--
--   326-0010  CARD MACHINE CLEARING — PBB
--   326-0020  CARD MACHINE CLEARING — MBB
--   326-0030  CARD MACHINE CLEARING — GHL
--   326-0040  CARD MACHINE CLEARING — HLB
--
-- SIBLINGS of 326-0000, not children: 父户不记账 — a parent header cannot be
-- posted to, and 326-0000 keeps its job as the GENERIC clearing account for a
-- card payment recorded without a bank (2990 holds 43 such installment rows
-- and 4 the owner chose to leave tagged CIMB, an acquirer it does not use).
-- Merchant reconciliation moves a matched payment from the generic account to
-- its bank's (the follow-up PR); the TRANSIT_EDC role stays 326-0000.
--
-- CIMB and AEON links are NOT touched: both are switched off for company 2
-- and keep pointing at the generic account. Company 1 (HOUZS) is not touched
-- (先别管 — its own split is its own decision).
--
-- Company 2 only, by id: the accounts table is per company (0297) and the
-- link table is keyed (company_id, acquirer_code) (0332). Idempotent: the
-- inserts ON CONFLICT DO NOTHING on (company_id, account_code); the updates
-- are absolute.

SET search_path = scm, public;

INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, is_active, acc_money, special_type, section)
VALUES
  (2, '326-0010', 'CARD MACHINE CLEARING — PBB', 'ASSET', NULL, true, false, NULL, 'CURRENT ASSETS'),
  (2, '326-0020', 'CARD MACHINE CLEARING — MBB', 'ASSET', NULL, true, false, NULL, 'CURRENT ASSETS'),
  (2, '326-0030', 'CARD MACHINE CLEARING — GHL', 'ASSET', NULL, true, false, NULL, 'CURRENT ASSETS'),
  (2, '326-0040', 'CARD MACHINE CLEARING — HLB', 'ASSET', NULL, true, false, NULL, 'CURRENT ASSETS')
ON CONFLICT (company_id, account_code) DO NOTHING;

UPDATE scm.acc_company_acquirers SET transit_account_code = '326-0010', updated_at = now() WHERE company_id = 2 AND acquirer_code = 'PBB';
UPDATE scm.acc_company_acquirers SET transit_account_code = '326-0020', updated_at = now() WHERE company_id = 2 AND acquirer_code = 'MBB';
UPDATE scm.acc_company_acquirers SET transit_account_code = '326-0030', updated_at = now() WHERE company_id = 2 AND acquirer_code = 'GHL';
UPDATE scm.acc_company_acquirers SET transit_account_code = '326-0040', updated_at = now() WHERE company_id = 2 AND acquirer_code = 'HLB';
