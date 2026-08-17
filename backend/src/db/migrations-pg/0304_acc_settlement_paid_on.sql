-- REVERSAL: additive only.
--   ALTER TABLE scm.acc_settlement_batches DROP COLUMN paid_on;
-- No existing row is modified; the column is nullable and every reader falls
-- back to the behaviour it had before.
--
-- acc_settlement_paid_on — the day the money actually reached the bank.
--
-- Owner decision, 2026-08-17. An acquirer does not pay on the day the card is
-- swiped. Public Bank's payment advice of 10 Aug covers batches it settled on
-- the 7th, 8th and 9th — RM 188,955.86 in one credit — so dating the bank leg
-- by the transaction date puts money in the bank account days before it is
-- there. Harmless mid-month; wrong across a month end, where the 31st's trading
-- would show in the bank balance of a month that never received it.
--
-- So the settlement entry is dated by the PAYOUT, and the swipe-to-payout gap
-- sits where it belongs: in settlement-in-transit, which is exactly the account
-- that exists to hold money in flight.
--
--   paid_on NULL  -> the entry keeps the statement line's own date, which is
--                    right for an acquirer that pays same-day and is the
--                    behaviour every existing batch already had.
-- NOTE: number re-checked against the tree at merge time.

ALTER TABLE scm.acc_settlement_batches ADD COLUMN paid_on DATE;

COMMENT ON COLUMN scm.acc_settlement_batches.paid_on IS
  'The day the acquirer''s money reached the bank (from its payment advice). '
  'The settlement entry is dated by this when set; the gap before it sits in '
  'settlement-in-transit.';
