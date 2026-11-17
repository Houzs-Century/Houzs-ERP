-- 20261117T1500_acc_bank_match_reason_qr_report.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
-- A bank DuitNow QR credit whose merchant report already accounts for it — every
-- QR line linked to its sale on Merchant Recon, the sales making the credit to
-- the sen — is now matched to those sales' entries without a hand (owner
-- 2026-11-17: 他应该和 merchant 一样我只要对一边; accounting-bank
-- applyMerchantAgreedMatches). Such a match is recorded as what it is,
-- "qr+report", so the screen can say "matched by itself: the merchant report
-- agrees". Without this word the first such match was refused by this check
-- ("violates check constraint acc_bank_match_reason") and "Match the obvious
-- ones now" on 2990's Hong Leong November statement matched nothing. No row
-- changes; only the set of words the column may hold widens.
--
-- REVERSAL: the UPDATE first, or the ADD fails on the rows this made possible —
--   UPDATE scm.acc_bank_statement_matches SET match_reason = 'manual' WHERE match_reason = 'qr+report';
--   ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_match_reason;
--   ALTER TABLE scm.acc_bank_statement_matches ADD CONSTRAINT acc_bank_match_reason
--     CHECK (match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual', 'amount+name', 'amount+document'));

ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_match_reason;
ALTER TABLE scm.acc_bank_statement_matches
  ADD CONSTRAINT acc_bank_match_reason
  CHECK (match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual', 'amount+name', 'amount+document', 'qr+report'));
