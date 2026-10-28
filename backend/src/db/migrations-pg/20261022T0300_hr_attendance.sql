-- 20261022T0300_hr_attendance.sql
-- REVERSAL: DROP TABLE IF EXISTS public.hr_attendance, public.hr_punch_sites;
--   Revert the code first: routes/attendance.ts (the phone punch), routes/hr.ts
--   (the Attendance tab and the punch sites) and the hr-auto-clockout cron are
--   the only readers and writers. Dropping loses the punches and the sites;
--   the selfies stay in R2 under hr-punch/ until deleted there.
--   GRANTS: none to re-apply. Reached only through the Worker's own
--   connection; this file only revokes anon / authenticated.
-- Verified against: not yet applied anywhere; the normal migrate-before-deploy
--   path applies it on merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two new
-- empty tables and their indexes; no row written, nothing existing altered.
--
-- WHY (HC-0125 phase 2, Nico): drivers and warehouse crew punch in / out on
-- the phone with their ERP account (option B), with a selfie and GPS, and HR
-- reads the day in Employees & Attendance > Attendance.
--   hr_punch_sites  where a punch counts as on site: a point and a radius per
--                   company (a warehouse, a showroom, HQ). The check is soft,
--                   as in Hookka: recorded and shown, never a refusal. Its own
--                   table, not columns on scm.warehouses, because a site need
--                   not be a stock location.
--   hr_attendance   one row per employee per work date. Both punches are
--                   instants (timestamptz), so a clock-out after midnight
--                   belongs to the day it started. Late / regular / OT minutes
--                   are NOT stored: they are computed from the two times and
--                   the pay rules in force on the work date.

CREATE TABLE IF NOT EXISTS public.hr_punch_sites (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    bigint           NOT NULL,
  name          text             NOT NULL,
  lat           double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng           double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m      integer          NOT NULL DEFAULT 200 CHECK (radius_m BETWEEN 20 AND 5000),
  active        boolean          NOT NULL DEFAULT true,
  created_at    timestamptz      NOT NULL DEFAULT now(),
  created_by    integer,
  updated_at    timestamptz      NOT NULL DEFAULT now(),
  updated_by    integer
);
CREATE INDEX IF NOT EXISTS idx_hr_punch_sites_company ON public.hr_punch_sites (company_id) WHERE active;

CREATE TABLE IF NOT EXISTS public.hr_attendance (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       bigint           NOT NULL,
  employee_id      bigint           NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  work_date        date             NOT NULL,
  status           text             NOT NULL DEFAULT 'PRESENT'
                     CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY', 'MEDICAL_LEAVE', 'ANNUAL_LEAVE', 'REST_DAY')),
  clock_in_at      timestamptz,
  clock_out_at     timestamptz,
  in_source        text             CHECK (in_source IN ('PHONE', 'MANUAL', 'AUTO')),
  out_source       text             CHECK (out_source IN ('PHONE', 'MANUAL', 'AUTO')),
  in_lat           double precision,
  in_lng           double precision,
  in_accuracy_m    integer,
  in_geo           text             CHECK (in_geo IN ('IN', 'OUT', 'NONE')),
  in_site_id       bigint           REFERENCES public.hr_punch_sites (id) ON DELETE SET NULL,
  in_distance_m    integer,
  in_photo_key     text,
  out_lat          double precision,
  out_lng          double precision,
  out_accuracy_m   integer,
  out_geo          text             CHECK (out_geo IN ('IN', 'OUT', 'NONE')),
  out_site_id      bigint           REFERENCES public.hr_punch_sites (id) ON DELETE SET NULL,
  out_distance_m   integer,
  out_photo_key    text,
  notes            text,
  created_at       timestamptz      NOT NULL DEFAULT now(),
  updated_at       timestamptz      NOT NULL DEFAULT now(),
  updated_by       integer,
  CONSTRAINT uq_hr_attendance_day UNIQUE (employee_id, work_date),
  CONSTRAINT hr_attendance_out_after_in CHECK (clock_out_at IS NULL OR (clock_in_at IS NOT NULL AND clock_out_at >= clock_in_at))
);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_company_date ON public.hr_attendance (company_id, work_date);
CREATE INDEX IF NOT EXISTS idx_hr_attendance_open ON public.hr_attendance (company_id, clock_in_at) WHERE clock_out_at IS NULL AND clock_in_at IS NOT NULL;

-- Kept off the PostgREST anon / authenticated roles: where people were and
-- their photos. RLS deliberately not enabled (prod Hyperdrive role not named
-- in this repo, see 0191).
REVOKE ALL ON public.hr_punch_sites, public.hr_attendance FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON public.hr_punch_sites, public.hr_attendance FROM anon;
END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON public.hr_punch_sites, public.hr_attendance FROM authenticated;
END IF; END $$;
