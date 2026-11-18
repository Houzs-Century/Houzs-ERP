-- 20261118T1700_hr_allowances_attendance_kind.sql
-- Allow the ATTENDANCE allowance kind. The hr_allowances.kind CHECK listed only
-- LEADERSHIP/TRANSPORT/OVERNIGHT/KPI/OTHER/BACKPAY (from 20261022T1500), so the
-- attendance allowance shipped in the code (#5802) could not actually be stored.
-- This widens the CHECK to include ATTENDANCE (a per-day rate the payroll
-- computes into a monthly line). Idempotent: the constraint is dropped by its
-- deterministic name and re-added.
--
-- REVERSAL: ALTER TABLE public.hr_allowances DROP CONSTRAINT hr_allowances_kind_check;
--   ALTER TABLE public.hr_allowances ADD CONSTRAINT hr_allowances_kind_check
--     CHECK (kind = ANY (ARRAY['LEADERSHIP','TRANSPORT','OVERNIGHT','KPI','OTHER','BACKPAY']));
--   Safe only once no ATTENDANCE rows remain (DELETE them first).

ALTER TABLE public.hr_allowances DROP CONSTRAINT IF EXISTS hr_allowances_kind_check;
ALTER TABLE public.hr_allowances ADD CONSTRAINT hr_allowances_kind_check
  CHECK (kind = ANY (ARRAY['LEADERSHIP', 'TRANSPORT', 'OVERNIGHT', 'KPI', 'ATTENDANCE', 'OTHER', 'BACKPAY']));
