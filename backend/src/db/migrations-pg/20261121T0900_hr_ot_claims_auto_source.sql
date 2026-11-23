-- 20261121T0900_hr_ot_claims_auto_source.sql
-- HC-0125 hybrid overtime (owner 2026-11-20). Overtime hours are now derived
-- from the day's punch and kept as ONE pending AUTO claim a supervisor still
-- confirms before it pays (reversing the report-a-window model of
-- 20261120T0900: a long punch earns a claim again, but confirmation still
-- gates pay). This tells the two kinds of claim apart and keeps the books to
-- at most one AUTO claim per employee-day so payroll never double-counts.
--
--   source   'REPORTED' (a worker typed a window) or 'AUTO' (from the punch).
--            Existing rows are worker-reported, so the default is 'REPORTED'.
--
-- No seed here. Additive and backwards-compatible: payroll reads CONFIRMED
-- claims by minutes regardless of source, so this changes no pay by itself.
--
-- REVERSAL:
--   DROP INDEX IF EXISTS public.uq_hr_ot_claims_auto_day;
--   ALTER TABLE public.hr_ot_claims DROP COLUMN IF EXISTS source;
--   (Safe: the column is new and additive. NOTE the punch-derived claims ship
--   in code, not here; roll the code back together, or the sync keeps writing
--   AUTO claims the dropped column can no longer mark.)

ALTER TABLE public.hr_ot_claims
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'REPORTED';

ALTER TABLE public.hr_ot_claims
  DROP CONSTRAINT IF EXISTS hr_ot_claims_source_check;
ALTER TABLE public.hr_ot_claims
  ADD CONSTRAINT hr_ot_claims_source_check CHECK (source IN ('REPORTED', 'AUTO'));

-- At most one AUTO claim per employee-day (the punch sync upserts it). Workers
-- may still file several REPORTED windows a day, so the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_ot_claims_auto_day
  ON public.hr_ot_claims (company_id, employee_id, work_date)
  WHERE source = 'AUTO';
