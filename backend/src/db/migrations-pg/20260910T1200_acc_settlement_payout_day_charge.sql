-- 20260910T1200_acc_settlement_payout_day_charge.sql
--
-- REVERSAL: drop the seven columns; nothing else reads them —
--   ALTER TABLE scm.acc_settlement_payout_batches
--     DROP COLUMN charge_sen, DROP COLUMN charge_account_code,
--     DROP COLUMN charge_note, DROP COLUMN charge_je_no, DROP COLUMN charge_je_id,
--     DROP COLUMN charge_by, DROP COLUMN charged_at;
--   Any SETTLECHARGE journal already posted stays in the ledger (reverse it
--   through the engine, never delete it).
--
-- WHAT THIS IS. A bank can deduct a charge from a payout — Public Bank took
-- RM 324.00 off the 2026-06-06 settlement of 2990 for a card-terminal
-- application fee, so the advice said RM 3,024.18 for a day whose merchant
-- report nets RM 3,348.18. The advice screen reported the difference and
-- stopped; nothing could book the RM 324, so the acquirer's transit account
-- would have stayed short by it for ever (owner, 2026-09-10: 我检查了好像是
-- 银行的卡机 application fees 来的，我该如何做).
--
-- The charge belongs to the ADVICE DAY it was deducted from, so it lives on
-- that row rather than in a new table: `statusOfPayout` already reads these
-- rows to decide whether a day agrees, and a day agrees when
--   report net = advice net + charge.
-- The account is the operator's choice (owner: 可以让我点了后选这笔进什么户口),
-- checked the way the merchant fee account is — expense, active, a leaf, this
-- company — and defaulting to the acquirer's fee account. The journal is
--   Dr <charge_account_code>   charge_sen
--   Cr <acquirer transit>      charge_sen
-- dated settled_on, source SETTLECHARGE keyed on this row's id. Undo reverses
-- it through the engine and clears these columns.

ALTER TABLE scm.acc_settlement_payout_batches
  ADD COLUMN charge_sen          BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN charge_account_code TEXT,
  ADD COLUMN charge_note         TEXT,
  ADD COLUMN charge_je_no        TEXT,
  ADD COLUMN charge_je_id        TEXT,
  ADD COLUMN charge_by           TEXT,
  ADD COLUMN charged_at          TIMESTAMPTZ,
  ADD CONSTRAINT acc_settlement_payout_day_charge_sign CHECK (charge_sen >= 0),
  -- A charge has an account, or there is no charge: the pair moves together.
  ADD CONSTRAINT acc_settlement_payout_day_charge_pair
    CHECK ((charge_sen = 0) = (charge_account_code IS NULL));

COMMENT ON COLUMN scm.acc_settlement_payout_batches.charge_sen IS
  'What the bank deducted from this day''s payout (a terminal fee, a chargeback fee). 0 when nothing was deducted. The day agrees when report net = advice net + charge.';
COMMENT ON COLUMN scm.acc_settlement_payout_batches.charge_account_code IS
  'The expense account the charge was booked to — the operator''s choice, defaulting to the acquirer''s fee account.';
