-- 20260930T1030_acc_settlement_receipt_charge.sql
--
-- REVERSAL: drop the five columns and the two checks; nothing else reads them —
--   ALTER TABLE scm.acc_settlement_receipts
--     DROP CONSTRAINT IF EXISTS acc_settlement_receipt_charge_pair,
--     DROP CONSTRAINT IF EXISTS acc_settlement_receipt_charge_sign,
--     DROP COLUMN IF EXISTS charge_sen, DROP COLUMN IF EXISTS charge_account_code,
--     DROP COLUMN IF EXISTS charge_note, DROP COLUMN IF EXISTS charge_je_no,
--     DROP COLUMN IF EXISTS charge_je_id;
--   Revert the code first (acc/settlement.ts, acc/payout-charge.ts, acc/bank.ts and
--   the settlement routes read these). Any SETTLECHARGE journal already posted
--   stays in the ledger — reverse it through the engine, never delete it.
--   GRANTS: none — columns on an existing table ride that table's grants.
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-09-30; the columns and the checks read back in the PR body.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: five new
-- columns on scm.acc_settlement_receipts, every existing row reading charge 0
-- (the default) with no account; no row is otherwise written.
--
-- WHY (owner 2026-09-30: 这个RM54 是charges 来的，和之前的public bank一样 → 做).
-- GHL paid 2990 RM 3,128.40 on 2026-09-02 for a report netting RM 3,182.40 —
-- RM 54.00 kept by the acquirer. Public Bank's RM 324 (20260910T1200) was booked
-- on its PAYMENT ADVICE day; GHL sends no advice, so the charge belongs to the
-- bank CREDIT it was kept from: the receipt row. The report is fully received
-- when credits + charges reach what it says it pays. The journal is
--   Dr <charge_account_code>   charge_sen
--   Cr <acquirer transit>      charge_sen
-- dated the report's settlement day (as the advice charge is), source
-- SETTLECHARGE keyed "SETTLECHARGE-R<receipt id>". Undoing the credit reverses
-- both its entries.

SET search_path = public, scm;

ALTER TABLE scm.acc_settlement_receipts
  ADD COLUMN IF NOT EXISTS charge_sen          BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS charge_account_code TEXT,
  ADD COLUMN IF NOT EXISTS charge_note         TEXT,
  ADD COLUMN IF NOT EXISTS charge_je_no        TEXT,
  ADD COLUMN IF NOT EXISTS charge_je_id        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acc_settlement_receipt_charge_sign') THEN
    ALTER TABLE scm.acc_settlement_receipts
      ADD CONSTRAINT acc_settlement_receipt_charge_sign CHECK (charge_sen >= 0);
  END IF;
  -- A charge has an account, or there is no charge: the pair moves together.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'acc_settlement_receipt_charge_pair') THEN
    ALTER TABLE scm.acc_settlement_receipts
      ADD CONSTRAINT acc_settlement_receipt_charge_pair CHECK ((charge_sen = 0) = (charge_account_code IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN scm.acc_settlement_receipts.charge_sen IS
  'What the acquirer or bank kept off THIS credit (a terminal rental, a fee) when it sends no advice to book it on. 0 when nothing was kept. The report is fully received when credits + charges reach its net.';
COMMENT ON COLUMN scm.acc_settlement_receipts.charge_account_code IS
  'The expense account the kept amount was booked to — the operator''s choice, defaulting to the acquirer''s fee account.';
