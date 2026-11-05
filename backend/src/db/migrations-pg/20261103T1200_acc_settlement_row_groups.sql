-- 20261103T1200_acc_settlement_row_groups.sql
-- Merchant report lines confirmed TOGETHER against several payments (owner
-- 2026-11-03, option B: 「B」). A customer swiped twice for two orders — GHL
-- 29/10/2026 RM 5,000 + RM 2,085 for 2990-SO-2610-055 RM 2,990 + SO-2610-056
-- RM 4,095 — so no line equals any payment or set of payments; only the
-- totals agree, to the sen.
--
-- The payments link ONCE (acc_settlement_payment_once still holds), to the
-- group's first line, the lead; every other line of the group points at the
-- lead here. Each line keeps its own fee entry (SETTLE-<row id>); the clearing
-- move is the lead's (SETTLEMOVE-<lead id>). Undoing any line of a group takes
-- the whole group back and clears this column.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT MERGE.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- nullable column on scm.acc_settlement_rows, every existing row reading NULL
-- (a line matched on its own); no row is written. ON DELETE SET NULL: a lead
-- removed with its report takes its members with it (the batch cascade), and
-- nothing else deletes a line.
--
-- REVERSAL:
--   Revert the code first (acc/settlement.ts, routes/accounting-settlement.ts
--   read this column). Undo every group first (each line's Undo), or the
--   members lose their pointer and read as lines with no payments.
--   DROP INDEX IF EXISTS scm.acc_settlement_rows_matched_with;
--   ALTER TABLE scm.acc_settlement_rows DROP COLUMN IF EXISTS matched_with_row_id;
--   GRANTS: none — a column on an existing table rides that table's grants.

SET search_path = public, scm;

ALTER TABLE scm.acc_settlement_rows
  ADD COLUMN IF NOT EXISTS matched_with_row_id BIGINT
    REFERENCES scm.acc_settlement_rows (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS acc_settlement_rows_matched_with
  ON scm.acc_settlement_rows (matched_with_row_id)
  WHERE matched_with_row_id IS NOT NULL;
