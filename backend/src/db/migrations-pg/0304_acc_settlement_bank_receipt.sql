-- REVERSAL: additive only.
--   ALTER TABLE scm.acc_settlement_batches
--     DROP COLUMN received_on, DROP COLUMN receipt_je_no,
--     DROP COLUMN receipt_je_id, DROP COLUMN receipt_posted_at;
-- No existing row is modified; every column is nullable.
--
-- acc_settlement_bank_receipt — reconciling the card machine and receiving the
-- money are TWO events, and the ledger now treats them as two.
--
-- Owner, 2026-08-17, correcting an earlier design of mine: "全部卡机都是隔几天
-- 收到的。应该是先对卡机报告，然后 match 了就会去 match bank statement". He is
-- right, and the version being replaced was wrong in a way that mattered — it
-- booked the bank on the strength of the acquirer's statement, i.e. it assumed
-- the money had arrived because the acquirer said it would. It also asked the
-- operator for the payout date at UPLOAD time, which is the one moment he
-- cannot know it: the bank statement is what tells him.
--
-- So settlement-in-transit is now emptied in two steps, and holds something
-- meaningful in between:
--
--   customer swipes        Dr in-transit  6,000.00   Cr AR          6,000.00
--   card machine matched   Dr fee           326.16   Cr in-transit    326.16
--     -> in-transit now holds 5,673.84: EXACTLY what the acquirer still owes,
--        because the fee is already lost and is no longer receivable
--   bank receives          Dr bank        5,673.84   Cr in-transit  5,673.84
--     -> in-transit 0
--
-- The customer's side is untouched by any of this: AR is knocked off by the
-- full 6,000.00 at the swipe (owner: "顾客还款确定到时是记录6000哦，不然knock
-- off 不到"). The fee is the merchant's cost, taken out of in-transit, never out
-- of what the customer owed.
-- NOTE: number re-checked against the tree at merge time.

ALTER TABLE scm.acc_settlement_batches
  -- The day the bank actually received it, off the bank statement or the
  -- acquirer's payment advice. NULL = the money is still with the acquirer.
  ADD COLUMN received_on        DATE,
  ADD COLUMN receipt_je_no      TEXT,
  ADD COLUMN receipt_je_id      TEXT,
  ADD COLUMN receipt_posted_at  TIMESTAMPTZ;

COMMENT ON COLUMN scm.acc_settlement_batches.received_on IS
  'The day the acquirer''s money reached the bank. Until it is set, this '
  'batch''s net is still sitting in settlement-in-transit — which is the '
  'correct answer, not a gap.';
