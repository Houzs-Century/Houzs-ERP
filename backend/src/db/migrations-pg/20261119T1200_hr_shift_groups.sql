-- 20261119T1200_hr_shift_groups.sql
-- HC-0125 per-employee shift groups: each employee can belong to a shift group
-- (e.g. Local 09:00-17:30, Foreign worker 09:00-19:00, Driver 08:30-17:00) that
-- overrides the single global pay-rules shift for lateness and OT. A group also
-- carries a delivery-day shift (start/end), used on a day DP sent the member on
-- a delivery (resolved from hr_trip_rows by trip_date + crew employee id); null
-- means no delivery variation. hr_employees.shift_group_id (nullable) links an
-- employee to a group; null falls back to the global pay-rules shift.
--
-- Times are minutes from midnight (540 = 09:00). No seed data here (shift times
-- are set per company from the app).
--
-- REVERSAL: ALTER TABLE public.hr_employees DROP COLUMN IF EXISTS shift_group_id;
--   DROP TABLE IF EXISTS public.hr_shift_groups;
--   (Safe: the table and column are new; dropping them makes lateness/OT fall
--   back to the global pay-rules shift, as before this migration.)

CREATE TABLE IF NOT EXISTS public.hr_shift_groups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  name text NOT NULL,
  start_min integer NOT NULL,
  end_min integer NOT NULL,
  delivery_start_min integer,
  delivery_end_min integer,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_shift_groups_company ON public.hr_shift_groups (company_id, sort_order);

ALTER TABLE public.hr_employees ADD COLUMN IF NOT EXISTS shift_group_id bigint;
