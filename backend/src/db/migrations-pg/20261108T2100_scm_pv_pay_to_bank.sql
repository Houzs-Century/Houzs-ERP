-- 20261108T2100_scm_pv_pay_to_bank.sql
-- REVERSAL: ALTER TABLE scm.payment_vouchers DROP COLUMN IF EXISTS pay_to_bank_name, DROP COLUMN IF EXISTS pay_to_account_no, DROP COLUMN IF EXISTS pay_to_account_name;
--   Revert the code first: routes/payment-vouchers-list.ts selects these and the voucher form sends them.
--
-- WHY (owner 2026-11-08: 「pv notes 我不想要全部挤在一排，然后把notes 换成description」, 「每天要过账的listing，
-- 就算pv号码，名字，description, purpose，包含bank account number」): the bank a voucher pays into rode in its
-- notes, on one line with everything else. It gets fields of its own, filled from the supplier or the payment
-- request when the voucher is made and changeable until it is checked; the notes (shown as Description) say only
-- what the money is for. Nullable: a voucher made before them reads its request's or its supplier's bank.

ALTER TABLE scm.payment_vouchers
  ADD COLUMN IF NOT EXISTS pay_to_bank_name    text,
  ADD COLUMN IF NOT EXISTS pay_to_account_no   text,
  ADD COLUMN IF NOT EXISTS pay_to_account_name text;

COMMENT ON COLUMN scm.payment_vouchers.pay_to_bank_name IS 'The bank the payee is paid into. Null on vouchers from before the column: they read the request''s or the supplier''s bank.';
COMMENT ON COLUMN scm.payment_vouchers.pay_to_account_no IS 'The payee''s account number at that bank.';
COMMENT ON COLUMN scm.payment_vouchers.pay_to_account_name IS 'The name the payee''s account is held in.';
