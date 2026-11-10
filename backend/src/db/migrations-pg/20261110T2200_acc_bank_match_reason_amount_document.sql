-- 20261110T2200_acc_bank_match_reason_amount_document.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
-- A bank movement whose words name a voucher — its number, or the Draft number
-- it went out under — with that voucher's amount is now matched to the voucher
-- without a hand, however many days after it the bank paid (owner 2026-11-10,
-- 2990's Hong Leong October: 银行单上写着 PV 号码的，直接配那张 PV，不管差几天 —
-- 可以). Such a match is recorded as what it is, "amount+document", beside the
-- rule's other reason ("amount+name") and a person's ("manual"), so a reader of
-- the match rows can tell which rule decided and the screen can say so. No row
-- changes; only the set of words the column may hold widens.
--
-- REVERSAL: the UPDATE first, or the ADD fails on the rows this made possible —
--   UPDATE scm.acc_bank_statement_matches SET match_reason = 'manual' WHERE match_reason = 'amount+document';
--   ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_match_reason;
--   ALTER TABLE scm.acc_bank_statement_matches ADD CONSTRAINT acc_bank_match_reason
--     CHECK (match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual', 'amount+name'));
-- Verified against: production, inside a transaction rolled back (see the PR).

ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_match_reason;
ALTER TABLE scm.acc_bank_statement_matches
  ADD CONSTRAINT acc_bank_match_reason
  CHECK (match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual', 'amount+name', 'amount+document'));
