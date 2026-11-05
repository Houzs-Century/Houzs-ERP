-- 20261022T1500_hr_trip_pay.sql
-- REVERSAL: DROP TABLE IF EXISTS public.hr_trip_missed_days, public.hr_trip_rows,
--   public.hr_trip_rate_versions, public.hr_allowances;
--   UPDATE public.hr_attendance SET status = 'ABSENT' WHERE status = 'UNPAID_LEAVE';
--   then re-add hr_attendance_status_check without 'UNPAID_LEAVE';
--   ALTER TABLE public.hr_payslips DROP COLUMN IF EXISTS commission_sen,
--   DROP COLUMN IF EXISTS trip_allowance_sen, DROP COLUMN IF EXISTS backpay_sen;
--   ALTER TABLE public.hr_employees DROP COLUMN IF EXISTS trip_names;
--   Revert the code first: routes/hr-trip-pay.ts, routes/lib/hr-trip-store.ts
--   and the payslip build (routes/lib/hr-payslip.ts, hr-payroll-store.ts) are
--   the only readers and writers. Dropping loses the pasted trip rows, the
--   trip rates and the monthly allowances; punches, hours and payslip pay
--   lines are untouched.
--   GRANTS: none to re-apply. Reached only through the Worker's own
--   connection; this file only revokes anon / authenticated.
-- Verified against: not yet applied anywhere; the normal migrate-before-deploy
--   path applies it on merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: four new
-- empty tables and their indexes; three zero-default columns on hr_payslips,
-- one nullable column on hr_employees, and one more allowed value in
-- hr_attendance.status (all three tables from the HC-0125 migrations of
-- 2026-10-21 / 22, holding no payroll yet); no row written.
--
-- WHY (HC-0125 phase 5, Nico 2026-10-22): the driver's commission and the trip
-- allowances of drivers and helpers, as her sheet "Houzs_Driver Comm + Worker
-- Allowance" pays them, and the monthly allowances she listed.
--   hr_trip_rows           one row per job a crew did, for a trip month (23rd of
--                          the previous month to the 22nd): pasted from her
--                          Trip Report (SHEET), pulled from Delivery Planning
--                          (PLANNING) or keyed (MANUAL). The kind (DO, fair,
--                          service, supplier, transfer...) is editable.
--   hr_trip_rate_versions  every rate, effective-dated like the pay rules.
--   hr_trip_missed_days    HR's count of missed days for a driver's month, when
--                          the punches cannot say (attendance not used yet).
--   hr_allowances          leadership / transport / overnight / KPI / other, one
--                          month or every month; BACKPAY (company advance) is
--                          deducted.
--   hr_attendance.status   + UNPAID_LEAVE: leave approved without pay. Absent
--                          for the salary, but (like annual / medical leave and
--                          rest days) not a missed day for the commission.
--   hr_employees.trip_names  the names a person goes by on the sheet (AMIR).
--   hr_payslips            commission, trip allowance and backpay as printed.

ALTER TABLE public.hr_employees ADD COLUMN IF NOT EXISTS trip_names text;

ALTER TABLE public.hr_attendance DROP CONSTRAINT IF EXISTS hr_attendance_status_check;
ALTER TABLE public.hr_attendance ADD CONSTRAINT hr_attendance_status_check
  CHECK (status IN ('PRESENT', 'ABSENT', 'HALF_DAY', 'MEDICAL_LEAVE', 'ANNUAL_LEAVE', 'REST_DAY', 'UNPAID_LEAVE'));

ALTER TABLE public.hr_payslips
  ADD COLUMN IF NOT EXISTS commission_sen     bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS trip_allowance_sen bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS backpay_sen        bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.hr_trip_rows (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id            bigint      NOT NULL,
  trip_month            text        NOT NULL CHECK (trip_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  source                text        NOT NULL CHECK (source IN ('SHEET', 'PLANNING', 'MANUAL')),
  source_ref            text,
  trip_date             date        NOT NULL,
  doc_no                text        NOT NULL DEFAULT '',
  transfer_to           text        NOT NULL DEFAULT '',
  ref_no                text        NOT NULL DEFAULT '',
  kind                  text        NOT NULL CHECK (kind IN ('DO', 'FAIR', 'FAIR_NIGHT', 'FAIR_NOON', 'FAIR_2ND', 'FAIR_2BOOTH', 'SERVICE_DELIVERY', 'SERVICE_PICKUP', 'SERVICE_INSPECTION', 'SUPPLIER', 'SUPPLIER_FULL', 'TRANSFER', 'NONE')),
  local_total_sen       bigint      NOT NULL DEFAULT 0 CHECK (local_total_sen >= 0),
  state                 text        NOT NULL DEFAULT '',
  lorry_plate           text        NOT NULL DEFAULT '',
  driver_1_name         text        NOT NULL DEFAULT '',
  driver_2_name         text        NOT NULL DEFAULT '',
  helper_1_name         text        NOT NULL DEFAULT '',
  helper_2_name         text        NOT NULL DEFAULT '',
  driver_1_employee_id  bigint      REFERENCES public.hr_employees (id) ON DELETE SET NULL,
  driver_2_employee_id  bigint      REFERENCES public.hr_employees (id) ON DELETE SET NULL,
  helper_1_employee_id  bigint      REFERENCES public.hr_employees (id) ON DELETE SET NULL,
  helper_2_employee_id  bigint      REFERENCES public.hr_employees (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            integer,
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_trip_rows_month ON public.hr_trip_rows (company_id, trip_month, trip_date);

CREATE TABLE IF NOT EXISTS public.hr_trip_rate_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint      NOT NULL,
  effective_from  date        NOT NULL,
  rates           jsonb       NOT NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      integer,
  CONSTRAINT uq_hr_trip_rate_versions_date UNIQUE (company_id, effective_from)
);

CREATE TABLE IF NOT EXISTS public.hr_trip_missed_days (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   bigint      NOT NULL,
  employee_id  bigint      NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  trip_month   text        NOT NULL CHECK (trip_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  missed_days  integer     NOT NULL CHECK (missed_days >= 0 AND missed_days <= 31),
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   integer,
  CONSTRAINT uq_hr_trip_missed_days UNIQUE (employee_id, trip_month)
);

CREATE TABLE IF NOT EXISTS public.hr_allowances (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     bigint      NOT NULL,
  employee_id    bigint      NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  kind           text        NOT NULL CHECK (kind IN ('LEADERSHIP', 'TRANSPORT', 'OVERNIGHT', 'KPI', 'OTHER', 'BACKPAY')),
  amount_sen     bigint      NOT NULL CHECK (amount_sen > 0),
  from_period    text        NOT NULL CHECK (from_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  until_period   text        CHECK (until_period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     integer,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_hr_allowances_range CHECK (until_period IS NULL OR until_period >= from_period)
);
CREATE INDEX IF NOT EXISTS idx_hr_allowances_employee ON public.hr_allowances (company_id, employee_id);

-- Kept off the PostgREST anon / authenticated roles: pay. RLS deliberately
-- not enabled (prod Hyperdrive role not named in this repo, see 0191).
REVOKE ALL ON public.hr_trip_rows, public.hr_trip_rate_versions, public.hr_trip_missed_days, public.hr_allowances FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON public.hr_trip_rows, public.hr_trip_rate_versions, public.hr_trip_missed_days, public.hr_allowances FROM anon;
END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON public.hr_trip_rows, public.hr_trip_rate_versions, public.hr_trip_missed_days, public.hr_allowances FROM authenticated;
END IF; END $$;
