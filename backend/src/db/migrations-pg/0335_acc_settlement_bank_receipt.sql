-- REVERSAL: additive only.
--   DROP TABLE scm.acc_settlement_receipts;
-- No existing table or row is modified.
--
-- acc_settlement_receipts — reconciling the card machine and receiving the
-- money are TWO events, and one statement is paid in ONE OR MORE credits.
--
-- Owner, 2026-08-17, correcting an earlier design of mine: "全部卡机都是隔几天
-- 收到的。应该是先对卡机报告，然后 match 了就会去 match bank statement" — and
-- then, of the first version of this table: "我实际收到的钱可能是多笔的哦".
--
-- He is right twice over. The version being replaced booked the bank on the
-- strength of the acquirer's statement (i.e. it assumed the money had arrived
-- because the acquirer said it would), and it assumed one statement meant one
-- credit. The real files say otherwise:
--
--   • Hong Leong's statement covers several trading days and is paid ONE CREDIT
--     PER DAY — two of them landed together on 18/06 at 14:36, RM 7,261.65 and
--     RM 1,788.28.
--   • Maybank credits each trading date separately (CR/CARD SALES ... DATED
--     DDMMYYYY), so a fortnight's statement arrives as a fortnight of credits.
--   • Public Bank goes the other way: one advice of 10 Aug paid for trading on
--     the 7th, 8th and 9th.
--
-- So a payout is its own row, with its own date, its own amount and its own
-- journal entry. A statement is "in the bank" when its receipts add up to what
-- it said it would pay; until then the difference is still sitting in
-- settlement-in-transit, which is the correct answer rather than a gap.
--
--   customer swipes        Dr in-transit  6,000.00   Cr AR          6,000.00
--   card machine matched   Dr fee           326.16   Cr in-transit    326.16
--     -> in-transit holds 5,673.84: EXACTLY what the acquirer still owes,
--        because the fee is already lost and is no longer receivable
--   each credit arrives    Dr bank          <that credit>  Cr in-transit ...
--     -> in-transit 0 once they add up
--
-- The customer's side is untouched by any of this: AR is knocked off by the
-- full 6,000.00 at the swipe (owner: "顾客还款确定到时是记录6000哦，不然knock
-- off 不到"). The fee is the merchant's cost, taken out of in-transit, never out
-- of what the customer owed.
--
-- Layer 4 (bank reconciliation) writes these same rows from the bank statement
-- itself; this table is the seam that makes that a read of real data rather
-- than a second, parallel notion of "paid".
-- NOTE: number re-checked against the tree at merge time.

CREATE TABLE scm.acc_settlement_receipts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id     BIGINT  NOT NULL REFERENCES scm.acc_settlement_batches (id) ON DELETE CASCADE,
  company_id   INTEGER NOT NULL,
  -- The day the bank shows the credit — off the bank statement, never off the
  -- acquirer's. The entry takes this date, so the books agree with the bank.
  received_on  DATE    NOT NULL,
  -- What THIS credit was. Negative is legal: an acquirer can claw a payout back.
  amount_sen   BIGINT  NOT NULL,
  -- Whatever identifies it on the bank statement, when there is something —
  -- HLB's "MERCHANT 20260616", Maybank's "DATED 14082026". Layer 4 fills it in.
  bank_ref     TEXT,
  note         TEXT,
  je_no        TEXT,
  je_id        TEXT,
  posted_at    TIMESTAMPTZ,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_settlement_receipt_amount CHECK (amount_sen <> 0)
);

CREATE INDEX acc_settlement_receipts_batch ON scm.acc_settlement_receipts (batch_id, received_on);
CREATE INDEX acc_settlement_receipts_co    ON scm.acc_settlement_receipts (company_id, received_on);

COMMENT ON TABLE scm.acc_settlement_receipts IS
  'One credit of an acquirer payout, as the BANK shows it. A statement may be '
  'paid in several; what its receipts do not yet add up to is still sitting in '
  'settlement-in-transit, which is the true answer to "how much do the '
  'acquirers still owe me".';
