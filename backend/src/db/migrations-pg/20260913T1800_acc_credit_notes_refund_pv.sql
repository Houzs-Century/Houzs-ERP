-- 20260913T1800_acc_credit_notes_refund_pv.sql
-- REVERSAL: ALTER TABLE scm.acc_credit_notes DROP COLUMN IF EXISTS refund_pv_id; — the
--   column is new and nullable, nothing existing is altered or backfilled, and
--   the partial index goes with it. Notes already raised through it keep their
--   rows; they simply stop naming the voucher. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NULLABLE COLUMN on scm.acc_credit_notes, and a partial index on it. No
-- row changes. The deployed application keeps working whether or not this
-- has run: the routes that write it ship in the same PR, and every existing
-- note reads NULL — "not a refund note", which is what every note is today.
--
-- WHY IT EXISTS (docs/bugs/0860). A deposit invoice books a customer's
-- payment as a sale the day it is received (Dr AR / Cr DEPOSIT PAY BY
-- CUSTOMER, docs/bugs/0828). When that money is refunded (the Customer
-- Refund voucher, Dr AR / Cr bank) the sale must be taken back by a CREDIT
-- NOTE against the deposit invoice — for the whole invoice or for PART of it
-- (owner 2026-09-13: partial refund 可以做; 就 DI 也需要开 CN). That note is
-- raised when the refund voucher posts and carries the voucher's id here, so
-- that (a) the voucher's cancel can find and contra exactly its notes, (b) the
-- final invoice can tell a refund note from its own close-out note and close
-- the invoice for the REMAINDER, and (c) the deposit-invoice page can name
-- the voucher beside each note. A note with no voucher id is what it always
-- was: a close-out note, or one Finance raised by hand.

SET search_path = public, scm;

ALTER TABLE scm.acc_credit_notes ADD COLUMN IF NOT EXISTS refund_pv_id uuid;

-- The read a voucher's cancel makes: every note THIS voucher raised.
CREATE INDEX IF NOT EXISTS idx_acc_credit_notes_refund_pv
  ON scm.acc_credit_notes (company_id, refund_pv_id)
  WHERE refund_pv_id IS NOT NULL;
