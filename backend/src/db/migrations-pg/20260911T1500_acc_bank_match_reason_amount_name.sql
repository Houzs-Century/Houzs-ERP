-- 20260911T1500_acc_bank_match_reason_amount_name.sql
--
-- REVERSAL: put the three-value check back —
--   UPDATE scm.acc_bank_statement_matches SET match_reason = 'manual' WHERE match_reason = 'amount+name';
--   ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_match_reason;
--   ALTER TABLE scm.acc_bank_statement_matches
--     ADD CONSTRAINT acc_bank_match_reason CHECK (match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual'));
--   (The UPDATE first, or the ADD fails on the rows this migration made possible.)
--
-- WHAT THIS IS. A bank movement with exactly one same-amount entry in the
-- books whose payee the bank's own text names is now matched without a hand
-- (owner, 2026-09-11, on a RM 45,000 rental transfer beside the one RM 45,000
-- voucher to NAVINDER SINGH GILL: 你看着 45,000 为什么我还需要自己 manual 匹配？
-- 只要名字金额一样就自动都对). Such a match is recorded as what it is —
-- "amount+name" — so a reader of the match rows can tell a rule's decision
-- from a person's ("manual") and from the acquirer-side reasons ("ref",
-- "amount+date"), and the screen can say "matched by amount and name" beside
-- it. No row changes; only the set of words the column may hold.

ALTER TABLE scm.acc_bank_statement_matches DROP CONSTRAINT acc_bank_match_reason;
ALTER TABLE scm.acc_bank_statement_matches
  ADD CONSTRAINT acc_bank_match_reason
  CHECK (match_reason IS NULL OR match_reason IN ('ref', 'amount+date', 'manual', 'amount+name'));
