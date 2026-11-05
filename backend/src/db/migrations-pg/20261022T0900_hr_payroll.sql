-- 20261022T0900_hr_payroll.sql
-- REVERSAL: DROP TABLE IF EXISTS public.hr_penalty_lines, public.hr_penalties,
--   public.hr_advances, public.hr_payslips;
--   Revert the code first: routes/hr-payroll.ts and the My pay half of
--   routes/attendance.ts are the only readers and writers. Dropping loses the
--   generated payslips, the advances and the penalties; working hours, docks
--   and punches are untouched.
--   GRANTS: none to re-apply. Reached only through the Worker's own
--   connection; this file only revokes anon / authenticated.
-- Verified against: not yet applied anywhere; the normal migrate-before-deploy
--   path applies it on merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: four new
-- empty tables and their indexes; no row written, nothing existing altered.
--
-- WHY (HC-0125 phase 4, ported from Hookka's payslips / employee_advances /
-- worker_penalties): the month's pay per employee from the logged hours and
-- docks of phase 3.
--   hr_payslips        one slip per employee per month, every figure stored as
--                      generated (a later rule change never rewrites an
--                      approved month). DRAFT -> APPROVED (the month locks,
--                      advances settle, penalties post) -> PAID. Unlike Hookka
--                      it stores the short-hour deduction and the PCB status
--                      it printed, and detail (absent dates, OT days).
--   hr_advances        cash advanced to an employee, deducted in full in the
--                      month of its date (Hookka: no instalments).
--   hr_penalties       a penalty with a free-text reference (Samuel 2026-10-22:
--                      Century has no production order to point at), DRAFT ->
--                      PENDING_APPROVAL -> APPROVED -> POSTED;
--   hr_penalty_lines   who pays how much, the payroll month it lands in, and
--                      the payslip that took it.

CREATE TABLE IF NOT EXISTS public.hr_payslips (
  id                        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id                bigint       NOT NULL,
  employee_id               bigint       NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  period                    text         NOT NULL CHECK (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status                    text         NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'PAID')),
  emp_no                    text         NOT NULL,
  employee_name             text         NOT NULL,
  department_name           text,
  pay_mode                  text         NOT NULL CHECK (pay_mode IN ('MONTHLY', 'DAILY')),
  full_salary_sen           bigint       NOT NULL DEFAULT 0,
  day_rate_sen              bigint       NOT NULL DEFAULT 0,
  hour_rate_sen             bigint       NOT NULL DEFAULT 0,
  days_worked               integer      NOT NULL DEFAULT 0,
  absent_days               integer      NOT NULL DEFAULT 0,
  absence_deduction_sen     bigint       NOT NULL DEFAULT 0,
  short_hours               numeric(6,2) NOT NULL DEFAULT 0,
  short_hour_deduction_sen  bigint       NOT NULL DEFAULT 0,
  basic_earned_sen          bigint       NOT NULL DEFAULT 0,
  ot_weekday_hours          numeric(6,2) NOT NULL DEFAULT 0,
  ot_sunday_hours           numeric(6,2) NOT NULL DEFAULT 0,
  ot_holiday_hours          numeric(6,2) NOT NULL DEFAULT 0,
  ot_weekday_pay_sen        bigint       NOT NULL DEFAULT 0,
  ot_sunday_pay_sen         bigint       NOT NULL DEFAULT 0,
  ot_holiday_pay_sen        bigint       NOT NULL DEFAULT 0,
  ot_pay_sen                bigint       NOT NULL DEFAULT 0,
  allowances_sen            bigint       NOT NULL DEFAULT 0,
  gross_sen                 bigint       NOT NULL DEFAULT 0,
  epf_employee_sen          bigint       NOT NULL DEFAULT 0,
  epf_employer_sen          bigint       NOT NULL DEFAULT 0,
  socso_employee_sen        bigint       NOT NULL DEFAULT 0,
  socso_employer_sen        bigint       NOT NULL DEFAULT 0,
  eis_employee_sen          bigint       NOT NULL DEFAULT 0,
  eis_employer_sen          bigint       NOT NULL DEFAULT 0,
  pcb_sen                   bigint       NOT NULL DEFAULT 0,
  pcb_status                text         NOT NULL CHECK (pcb_status IN ('DISABLED', 'COMPUTED', 'ZERO_PROVEN', 'UNKNOWN')),
  statutory_employee_sen    bigint       NOT NULL DEFAULT 0,
  advance_sen               bigint       NOT NULL DEFAULT 0,
  penalty_sen               bigint       NOT NULL DEFAULT 0,
  net_sen                   bigint       NOT NULL DEFAULT 0,
  payment_method            text         NOT NULL DEFAULT 'TRANSFER' CHECK (payment_method IN ('TRANSFER', 'CASH')),
  bank_name                 text,
  bank_account              text,
  detail                    jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz  NOT NULL DEFAULT now(),
  created_by                integer,
  updated_at                timestamptz  NOT NULL DEFAULT now(),
  approved_at               timestamptz,
  approved_by               integer,
  paid_at                   timestamptz,
  paid_by                   integer,
  CONSTRAINT uq_hr_payslips_period UNIQUE (employee_id, period)
);
CREATE INDEX IF NOT EXISTS idx_hr_payslips_company_period ON public.hr_payslips (company_id, period);

CREATE TABLE IF NOT EXISTS public.hr_advances (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint      NOT NULL,
  employee_id     bigint      NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  advance_date    date        NOT NULL,
  amount_sen      bigint      NOT NULL CHECK (amount_sen > 0),
  note            text,
  status          text        NOT NULL DEFAULT 'UNSETTLED' CHECK (status IN ('UNSETTLED', 'SETTLED')),
  settled_period  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      integer,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_advances_company_date ON public.hr_advances (company_id, advance_date);

CREATE TABLE IF NOT EXISTS public.hr_penalties (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       bigint      NOT NULL,
  penalty_no       text        NOT NULL,
  penalty_date     date        NOT NULL,
  reference        text,
  reason           text        NOT NULL,
  remarks          text,
  status           text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED')),
  created_by       integer,
  created_by_name  text,
  submitted_at     timestamptz,
  approved_by      integer,
  approved_by_name text,
  approved_at      timestamptz,
  rejected_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_hr_penalties_no UNIQUE (company_id, penalty_no)
);

CREATE TABLE IF NOT EXISTS public.hr_penalty_lines (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint      NOT NULL,
  penalty_id      bigint      NOT NULL REFERENCES public.hr_penalties (id) ON DELETE CASCADE,
  employee_id     bigint      NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  amount_sen      bigint      NOT NULL CHECK (amount_sen > 0),
  payroll_period  text,
  payslip_id      bigint      REFERENCES public.hr_payslips (id) ON DELETE SET NULL,
  posted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_hr_penalty_lines_period ON public.hr_penalty_lines (company_id, payroll_period);

-- Kept off the PostgREST anon / authenticated roles: pay. RLS deliberately
-- not enabled (prod Hyperdrive role not named in this repo, see 0191).
REVOKE ALL ON public.hr_payslips, public.hr_advances, public.hr_penalties, public.hr_penalty_lines FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON public.hr_payslips, public.hr_advances, public.hr_penalties, public.hr_penalty_lines FROM anon;
END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON public.hr_payslips, public.hr_advances, public.hr_penalties, public.hr_penalty_lines FROM authenticated;
END IF; END $$;
