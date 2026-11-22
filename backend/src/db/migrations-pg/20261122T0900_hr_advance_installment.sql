-- 20261122T0900_hr_advance_installment.sql
-- HR employee advances repaid over several months (owner 2026-11-22). Until now
-- an advance came off the payslip of the month it was given, in full. It can now
-- be spread: installment_sen is the amount to deduct each payroll month, starting
-- that same month, until the advance is cleared (the last month takes whatever is
-- left). The owner's two input modes — "split into N months" and "fixed RM per
-- month" — both reduce to this one per-month figure, computed in the UI.
--
--   installment_sen  per-month deduction in sen, or NULL for a lump sum.
--
-- Additive and backwards-compatible: every existing advance keeps NULL, so it
-- still deducts in full in its own month and no pay changes by this alone. The
-- schedule is recomputed from (advance_date, amount_sen, installment_sen) each
-- payroll run, so there is no per-month state to seed or backfill.
--
-- REVERSAL:
--   ALTER TABLE public.hr_advances DROP COLUMN IF EXISTS installment_sen;
--   (Safe: the column is new and additive. Roll the code back together, or the
--   routes keep writing installment_sen the dropped column can no longer hold.)

ALTER TABLE public.hr_advances
  ADD COLUMN IF NOT EXISTS installment_sen bigint
  CHECK (installment_sen IS NULL OR installment_sen > 0);
