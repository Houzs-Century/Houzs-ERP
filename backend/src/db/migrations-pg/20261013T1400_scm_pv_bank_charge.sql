-- 20261013T1400_scm_pv_bank_charge.sql
-- DEV-75: Finance records the bank charge on a Payment Voucher header.
-- Stored and shown only: it is NOT in total_sen and posts nothing to the GL
-- (no account chosen for it yet). Integer sen, never negative.

ALTER TABLE scm.payment_vouchers ADD COLUMN IF NOT EXISTS bank_charge_sen integer NOT NULL DEFAULT 0;
DO $$ BEGIN ALTER TABLE scm.payment_vouchers ADD CONSTRAINT payment_vouchers_bank_charge_sen_nonneg CHECK (bank_charge_sen >= 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- REVERSAL: ALTER TABLE scm.payment_vouchers DROP COLUMN IF EXISTS bank_charge_sen;
