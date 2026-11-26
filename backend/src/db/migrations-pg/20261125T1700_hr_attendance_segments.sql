-- HR actual clocking (HC-0125): a work day can hold several clock-in/out pairs
-- (clock 1-4), each recorded with its own evidence, so presence is proven per
-- punch. The segments live in one JSONB column on hr_attendance; the day's
-- clock_in_at / clock_out_at stay as the FIRST in and LAST out, so every
-- existing reader (attendance view, payroll, docks, trip sync) is unchanged.
-- An existing row with segments NULL is read as its single clock_in/out pair.
-- REVERSAL: ALTER TABLE public.hr_attendance DROP COLUMN IF EXISTS segments;
ALTER TABLE public.hr_attendance ADD COLUMN IF NOT EXISTS segments jsonb;
