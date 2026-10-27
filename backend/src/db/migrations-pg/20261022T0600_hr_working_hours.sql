-- 20261022T0600_hr_working_hours.sql
-- REVERSAL: DROP TABLE IF EXISTS public.hr_hour_deductions, public.hr_working_hours;
--   Revert the code first: routes/hr-labor.ts, the punch hooks in
--   routes/lib/hr-labor-store.ts (called from routes/attendance.ts and
--   routes/hr-attendance.ts) are the only readers and writers. Dropping loses
--   the logged hours and the short-hour docks; the punches themselves stay in
--   hr_attendance.
--   GRANTS: none to re-apply. Reached only through the Worker's own
--   connection; this file only revokes anon / authenticated.
-- Verified against: not yet applied anywhere; the normal migrate-before-deploy
--   path applies it on merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- empty tables and their indexes; no row written, nothing existing altered.
--
-- WHY (HC-0125 phase 3, ported from Hookka's working_hour_entries and
-- payroll_hour_deductions): pay reads the hours LOGGED for a day, not the punch
-- row, and docks the short hours a punch shows.
--   hr_working_hours    the hours of one attendance day, by department. A
--                       clock-out writes one AUTO row in the employee's own
--                       department (regular + OT as one figure; the day type
--                       decides the OT); HR adds or edits rows (MANUAL), and an
--                       AUTO row is never written over a MANUAL one. Hookka's
--                       SOFA / BEDFRAME category is not ported: no production.
--   hr_hour_deductions  short hours docked for a day, one row per employee per
--                       day. AUTO from the punch (late + left early, after
--                       same-day OT offsets them) or MANUAL by HR; an AUTO row
--                       never replaces a MANUAL one.

CREATE TABLE IF NOT EXISTS public.hr_working_hours (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint       NOT NULL,
  attendance_id   bigint       NOT NULL REFERENCES public.hr_attendance (id) ON DELETE CASCADE,
  employee_id     bigint       NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  work_date       date         NOT NULL,
  department_id   integer      REFERENCES public.departments (id) ON DELETE SET NULL,
  hours           numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  source          text         NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('AUTO', 'MANUAL')),
  notes           text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  created_by      integer,
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  updated_by      integer
);
CREATE INDEX IF NOT EXISTS idx_hr_working_hours_company_date ON public.hr_working_hours (company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_hr_working_hours_attendance ON public.hr_working_hours (attendance_id);

CREATE TABLE IF NOT EXISTS public.hr_hour_deductions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint       NOT NULL,
  employee_id     bigint       NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  work_date       date         NOT NULL,
  hours           numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  source          text         NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('AUTO', 'MANUAL')),
  note            text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  created_by      integer,
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_hr_hour_deductions_day UNIQUE (employee_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_hr_hour_deductions_company_date ON public.hr_hour_deductions (company_id, work_date);

-- Kept off the PostgREST anon / authenticated roles: pay inputs. RLS
-- deliberately not enabled (prod Hyperdrive role not named in this repo, see
-- 0191).
REVOKE ALL ON public.hr_working_hours, public.hr_hour_deductions FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON public.hr_working_hours, public.hr_hour_deductions FROM anon;
END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON public.hr_working_hours, public.hr_hour_deductions FROM authenticated;
END IF; END $$;
