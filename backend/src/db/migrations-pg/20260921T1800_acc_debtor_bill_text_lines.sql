-- 20260921T1800_acc_debtor_bill_text_lines.sql
-- REVERSAL: DELETE FROM scm.acc_debtor_bill_lines WHERE credit_account_code IS NULL;
--   ALTER TABLE scm.acc_debtor_bill_lines ALTER COLUMN credit_account_code SET NOT NULL; — the
--   text lines raised after this migration are the only NULL rows (nothing existing is
--   touched by it), and they book nothing, so removing them changes no journal and no
--   bill total. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NOT NULL DROPPED on scm.acc_debtor_bill_lines.credit_account_code. No row
-- changes, no index. The deployed application keeps working whether or not this
-- has run: the route that writes a NULL ships in the same PR, and every existing
-- line keeps its account.
--
-- WHY IT EXISTS (owner 2026-09-21: 有一些我只想放 description 罢了，就是给人看到
-- detail). A debtor bill's lines were all money lines — an account and a positive
-- amount — so a line meant only to explain the charge on the printed invoice
-- could not be saved. A TEXT line carries a description alone: no account, an
-- amount of zero, printed on the paper, booked by nobody, never in the total.
-- A bill still needs at least one money line.

SET search_path = public, scm;

ALTER TABLE scm.acc_debtor_bill_lines ALTER COLUMN credit_account_code DROP NOT NULL;
