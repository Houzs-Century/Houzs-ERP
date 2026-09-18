-- 20260908T2100_acc_bank_statement_hlb_2990.sql
-- REVERSAL: DELETE FROM scm.acc_bank_recognition_rules WHERE acquirer_code = 'GHL' AND pattern = '/GHL/|FOR GHL';
--   UPDATE scm.acc_bank_recognition_rules SET trading_date_pattern = 'MERCHANT\s+(\d{8})', merchant_pattern = '(\d{9,})\s+MERCHANT' WHERE acquirer_code = 'HLB' AND pattern = 'CA Credit Advice';
--   DELETE FROM scm.acc_bank_statement_config WHERE company_id = 2 AND account_code = '310-0020' AND bank_code = 'HLB';
--   Data rows only, no DDL. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Three data rows. (1) ONE new bank-recognition rule for GHL, guarded by the
--   same EXISTS the 0336 seed used (the acquirer must exist in
--   acc_acquirer_config — it does on prod, 2990's card machine). (2) TWO regex
--   columns on the existing HLB rule (prod row id 4, read 2026-09-08:
--   'MERCHANT\s+(\d{8})' / '(\d{9,})\s+MERCHANT'), loosened so they also match
--   the same reference after Hong Leong's any-day export split the word
--   "MERCHANT" across two columns ("00005992284  MERCHAN" | "T 20260824");
--   the monthly statement's "00005992235  MERCHANT 20260617" still matches.
--   (3) ONE bank-statement config for company 2 — the table was EMPTY for both
--   companies on prod (read 2026-09-08), which is why /scm/bank-recon said
--   "No bank account is set up to take a statement in this company yet".
--
-- WHY (owner 2026-09-08, on Bank Recon: 他一定要 from merchant recon 才能到 bank
-- recon 吗? … 别卡死读 column, 我怕未来 bank 可能换 format … 可能隔几天我就做一次).
-- The eight Hong Leong files he handed over (acs_23600602788_*.csv monthly,
-- Transaction_Statement_*.csv any-day) fix the shape:
--   • 2990 HOME's HLB PRIMEBIZ current account 23600602788 is chart account
--     310-0020 (CASH AT BANK - HLBB, 2990's default bank);
--   • the monthly export captions Date / Transaction Description / Ref. No. /
--     Deposit / Withdrawal / Balance; the any-day export Transaction Date /
--     Remarks / Sender-Receiver Name / Receipient Reference / Other Payment
--     Details / Payment Amount / Credit Amount / Balance — so the column map
--     names BOTH sets (JSON arrays; the reader tries each name, and carries
--     built-in synonyms on top so a re-captioned column still reads);
--   • GHL's payouts arrive on that statement as an interbank GIRO credit whose
--     reference reads "161320P226260720 /GHL/6600030486 DMS A3 (FOR GHL)" —
--     no rule existed, so GHL money read as "not a card payout" for ever.
--
-- Company 2 only, by id; HOUZS (company 1) untouched (先别管). Idempotent: the
-- rule insert and the config insert are guarded by NOT EXISTS, the UPDATE is
-- absolute on its named row.

SET search_path = scm, public;

-- (1) GHL — settles by interbank GIRO from DMS/GHL; the merchant number rides
--     after "/GHL/". No trading date in the narrative (the payout date is what
--     the bank prints), so none is captured.
INSERT INTO scm.acc_bank_recognition_rules
  (acquirer_code, pattern, match_field, trading_date_pattern, merchant_pattern, sort_order, note)
SELECT 'GHL', '/GHL/|FOR GHL', 'both', NULL, '/GHL/(\d{6,})', 50,
       'Cr Adv-Interbank GIRO, reference "161320P226260720 /GHL/6600030486 DMS A3 (FOR GHL)". The number after /GHL/ is the merchant id; no trading day is named.'
WHERE EXISTS (SELECT 1 FROM scm.acc_acquirer_config c WHERE c.code = 'GHL')
  AND NOT EXISTS (SELECT 1 FROM scm.acc_bank_recognition_rules r WHERE r.acquirer_code = 'GHL' AND r.pattern = '/GHL/|FOR GHL');

-- (2) HLB — the any-day export splits "MERCHANT" across two columns; the
--     reader joins them with a space, so the word arrives as "MERCHAN T".
UPDATE scm.acc_bank_recognition_rules
   SET trading_date_pattern = 'MERCHAN\s*T\s+(\d{8})',
       merchant_pattern     = '(\d{9,})\s+MERCHAN'
 WHERE acquirer_code = 'HLB' AND pattern = 'CA Credit Advice';

-- (3) 2990's Hong Leong current account takes a statement.
INSERT INTO scm.acc_bank_statement_config
  (company_id, account_code, bank_code, account_no, statement_format, delimiter, amount_format, credit_indicator, column_map, is_active)
SELECT 2, '310-0020', 'HLB', '23600602788', 'CSV', NULL, 'decimal', 'CR',
       '{
          "date":        ["Date", "Transaction Date"],
          "description": ["Transaction Description", "Remarks"],
          "reference":   ["Ref. No.", "Sender / Receiver Name", "Receipient Reference", "Other Payment Details"],
          "debit":       ["Withdrawal", "Payment Amount"],
          "credit":      ["Deposit", "Credit Amount"],
          "balance":     ["Balance"]
        }'::jsonb,
       TRUE
WHERE EXISTS (SELECT 1 FROM scm.accounts a WHERE a.company_id = 2 AND a.account_code = '310-0020')
  AND NOT EXISTS (SELECT 1 FROM scm.acc_bank_statement_config x WHERE x.company_id = 2 AND x.account_code = '310-0020');
