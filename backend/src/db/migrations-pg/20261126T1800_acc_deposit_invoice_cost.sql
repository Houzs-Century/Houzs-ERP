-- 20261126T1800_acc_deposit_invoice_cost.sql
--
-- WHY. AutoCount booked 34% of its deposit sales as cost; the ERP's deposit
-- invoice booked the sale alone. The owner, 2026-11-26, asked whether deposit
-- invoices should book that cost too: 「记」 — Dr 619-0000 COST OF PURCHASE
-- BASED ON DEPOSIT / Cr 410-0080 ACCRUAL - COST OF GOOD SOLD, released when the
-- final invoice's note takes the deposit back (acc/deposit-cost.ts).
--
-- WHAT THIS CHANGES.
-- 1. scm.acc_company_settings.deposit_cost_pct — the share of each deposit
--    invoice a company books as cost, in percent. NULL books none, which is
--    every company's value here: the code reads it, and the back-fill script
--    (scripts/backfill-deposit-invoice-cost.mjs) sets Houzs's on the owner's
--    yes, then posts the invoices already issued again with their cost.
-- 2. scm.acc_deposit_invoices.cost_sen — the cost the invoice's entry booked.
--    NULL for an invoice posted before its company booked any (what the
--    back-fill looks for); 0 for one posted while the company books none.
-- Nothing posts here.
--
-- Additive, idempotent, schema-qualified, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   Revert the code first, then, while no company books a cost:
--     ALTER TABLE scm.acc_deposit_invoices DROP COLUMN IF EXISTS cost_sen;
--     ALTER TABLE scm.acc_company_settings DROP COLUMN IF EXISTS deposit_cost_pct;
--     NOTIFY pgrst, 'reload schema';
--   Entries already posted with a cost stay in the books; reverse them by hand.

ALTER TABLE scm.acc_company_settings
  ADD COLUMN IF NOT EXISTS deposit_cost_pct numeric(5, 2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'acc_company_settings_deposit_cost_pct_range'
       AND conrelid = 'scm.acc_company_settings'::regclass
  ) THEN
    ALTER TABLE scm.acc_company_settings
      ADD CONSTRAINT acc_company_settings_deposit_cost_pct_range
      CHECK (deposit_cost_pct IS NULL OR (deposit_cost_pct > 0 AND deposit_cost_pct < 100));
  END IF;
END $$;

COMMENT ON COLUMN scm.acc_company_settings.deposit_cost_pct IS
  'Share of each deposit invoice booked as cost, percent (Dr DEPOSIT_COST / Cr DEPOSIT_COST_ACCRUAL; acc/deposit-cost.ts). NULL = none. Owner 2026-11-26.';

ALTER TABLE scm.acc_deposit_invoices
  ADD COLUMN IF NOT EXISTS cost_sen bigint;

COMMENT ON COLUMN scm.acc_deposit_invoices.cost_sen IS
  'Cost the invoice''s entry booked, sen. NULL = posted before its company booked any; 0 = none booked. Released by the notes that take the deposit back.';

NOTIFY pgrst, 'reload schema';
