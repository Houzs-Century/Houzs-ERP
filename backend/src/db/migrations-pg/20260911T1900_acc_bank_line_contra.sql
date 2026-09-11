-- 20260911T1900_acc_bank_line_contra.sql
--
-- REVERSAL: ALTER TABLE scm.acc_bank_statement_lines DROP COLUMN contra_line_id;
--   Lines already left out as a pair stay IGNORED with their notes; undo then
--   reopens one line at a time instead of both.
--
-- WHAT THIS IS. A failed bank transfer and the bank's own same-day reversal of
-- it are one decision about two lines (owner, 2026-09-11, on Hong Leong's
-- 04/06 pair: 这两笔是 contra 的，bank transaction fail). Both halves leave the
-- reconciliation IGNORED, each naming the other here, so that undo of either
-- reopens both and a reader of the rows can tell the bank's contra from a
-- person's "not ours to reconcile" (which carries a note and no twin).
-- Nullable, no default, no backfill: a line left out by hand has no twin, and
-- the pairs already on file are taken the next time the rule runs over the
-- statement ("Match the obvious ones now").
--
-- Reversal / Verified against: in the PR body, where the check reads them.

ALTER TABLE scm.acc_bank_statement_lines
  ADD COLUMN IF NOT EXISTS contra_line_id BIGINT NULL
    REFERENCES scm.acc_bank_statement_lines (id) ON DELETE SET NULL;

COMMENT ON COLUMN scm.acc_bank_statement_lines.contra_line_id IS
  'The other half of a pair the bank itself reversed (docs/bugs/0817): set on both lines, IGNORED together, reopened together.';
