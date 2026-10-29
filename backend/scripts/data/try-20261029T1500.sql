-- 20261029T1500_acc_official_receipts_cancel.sql
-- REVERSAL: revert the code first (acc/receipts.ts followPaymentEdit /
--   followPaymentRemoval, the CANCELLED filters on every receipt read, the Official
--   Receipts page). Then, only while no receipt is CANCELLED — a cancelled receipt and
--   its replacement are two rows for one payment, so the old one-per-payment key
--   cannot come back over them (delete nothing; ask):
--     ALTER TABLE scm.acc_official_receipts ADD CONSTRAINT acc_official_receipts_payment_source_payment_id_key UNIQUE (payment_source, payment_id);
--     DROP INDEX IF EXISTS scm.acc_official_receipts_payment_source_payment_id_live;
--     ALTER TABLE scm.acc_official_receipts DROP CONSTRAINT IF EXISTS acc_official_receipts_cancelled_when;
--     ALTER TABLE scm.acc_official_receipts DROP CONSTRAINT IF EXISTS acc_official_receipts_status_check;
--     ALTER TABLE scm.acc_official_receipts ADD CONSTRAINT acc_official_receipts_status_check CHECK (status IN ('DRAFT', 'FORMAL'));
--     ALTER TABLE scm.acc_official_receipts DROP COLUMN IF EXISTS replaced_by_id, DROP COLUMN IF EXISTS cancel_reason,
--       DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancelled_at;
--   GRANTS: none — the columns and the index ride the table's existing privileges.
-- Verified against: PRODUCTION, inside one transaction ROLLED BACK — PENDING (the
--   prod trial fills this line in before the PR leaves draft).
--
-- WHAT THIS CHANGES, and why it is safe to run against production: four nullable
-- columns (no rewrite); the status CHECK widened by one value every row already
-- passes; a CHECK that a cancelled receipt carries its cancel time, which every row
-- passes (none is cancelled); and the one-receipt-per-payment key narrowed to the
-- receipts that are not cancelled — the partial unique index is built while the old
-- constraint still holds and covers exactly today's rows, so there is no moment
-- without the key. No row is written or altered.
--
-- WHY (owner 2026-10-29: 收据跟着付款改或作废 — 「做」). 2990's October receipts
-- check showed RM 3,359 of receipts saying what their payments no longer said: a card
-- payment corrected from RM 1,115 to RM 558 two minutes after it was keyed, a cash
-- payment deleted a minute after it was keyed, a transfer re-dated from 13/10 to
-- 08/09 — each receipt stayed as issued, because nothing could change one. Now a
-- DRAFT receipt follows its payment and goes with it; a FORMAL one, already in the
-- customer's hand, is never rewritten: it is CANCELLED (kept, its number never
-- reused, the reason and who on it, replaced_by_id naming its successor) and the
-- payment gets a new receipt — the deposit invoice's rule, cancelled and re-issued.
-- A cancelled receipt and its replacement are two rows for one payment, so the key
-- covers the live ones only. Its name keeps "payment_source" because
-- createReceiptForPayment tells a duplicate payment from a number clash by it.

ALTER TABLE scm.acc_official_receipts
  ADD COLUMN IF NOT EXISTS cancelled_at   timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by   text,
  ADD COLUMN IF NOT EXISTS cancel_reason  text,
  ADD COLUMN IF NOT EXISTS replaced_by_id bigint REFERENCES scm.acc_official_receipts (id) ON DELETE SET NULL;

ALTER TABLE scm.acc_official_receipts DROP CONSTRAINT IF EXISTS acc_official_receipts_status_check;
ALTER TABLE scm.acc_official_receipts ADD CONSTRAINT acc_official_receipts_status_check
  CHECK (status IN ('DRAFT', 'FORMAL', 'CANCELLED'));

ALTER TABLE scm.acc_official_receipts DROP CONSTRAINT IF EXISTS acc_official_receipts_cancelled_when;
ALTER TABLE scm.acc_official_receipts ADD CONSTRAINT acc_official_receipts_cancelled_when
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS acc_official_receipts_payment_source_payment_id_live
  ON scm.acc_official_receipts (payment_source, payment_id) WHERE status <> 'CANCELLED';
ALTER TABLE scm.acc_official_receipts DROP CONSTRAINT IF EXISTS acc_official_receipts_payment_source_payment_id_key;
