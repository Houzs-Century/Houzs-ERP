-- 20261123T1300_hr_employee_permit_confirm.sql
-- HR employee record: two compliance dates the master never held (owner
-- 2026-11-23). Until now an employee had IC and passport numbers but no way to
-- say when a foreign worker's work permit lapses, nor when someone on probation
-- is due to be confirmed. HR now fills these on the employee form, and the
-- Employees & Attendance Overview turns them into reminders:
--   work_permit_expiry  the foreign worker's permit expiry (Overview flags the
--                        ones expiring within 90 days, and any already lapsed).
--   confirm_due_on       the day they are due to be confirmed off probation
--                        (Overview lists the ones coming up). No new employee
--                        status: an ACTIVE employee simply carries this date.
--
-- Both nullable and additive: every existing row stays NULL, so nothing is
-- flagged until HR enters a date, and no pay or status changes by this alone.
--
-- REVERSAL:
--   ALTER TABLE public.hr_employees DROP COLUMN IF EXISTS work_permit_expiry;
--   ALTER TABLE public.hr_employees DROP COLUMN IF EXISTS confirm_due_on;
--   (Safe: both columns are new and additive. Roll the code back together, or
--   the routes keep writing columns the dropped ones can no longer hold.)

ALTER TABLE public.hr_employees
  ADD COLUMN IF NOT EXISTS work_permit_expiry date,
  ADD COLUMN IF NOT EXISTS confirm_due_on date;

COMMENT ON COLUMN public.hr_employees.work_permit_expiry IS
  'Foreign worker''s work permit expiry date; Overview flags permits expiring within 90 days or already lapsed (20261123T1300).';
COMMENT ON COLUMN public.hr_employees.confirm_due_on IS
  'Day the employee is due to be confirmed off probation; Overview lists upcoming confirmations (20261123T1300).';
