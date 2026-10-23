-- 20261021T0300_hr_employees.sql
-- REVERSAL: DROP TABLE IF EXISTS public.hr_employee_salary_history,
--   public.hr_employees, public.hr_public_holidays, public.hr_pay_rule_versions;
--   Revert the code first: routes/hr.ts is the only reader and writer. The
--   tables hold what HR typed into Employees & Attendance (employee profiles,
--   salary changes, public holidays, scheduled pay-rule changes); dropping them
--   loses that and nothing else.
--   GRANTS: none to re-apply. Reached only through the Worker's own
--   connection; this file only revokes anon / authenticated.
-- Verified against: not yet applied anywhere; the normal migrate-before-deploy
--   path applies it on merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: four new
-- empty tables and their indexes; no row written, nothing existing altered.
--
-- WHY (HC-0125, Nico, owner OK 2026-10-20): port Hookka's Employees &
-- Attendance so drivers and warehouse crew can punch in / out and be paid from
-- the hours. Phase 1 is the master data the later phases read:
--   hr_employees                the Employee Master row (pay basis, statutory
--                               flags, bank). user_id links the ERP account the
--                               person punches with (Nico: option B); NULL until
--                               HR links one.
--   hr_employee_salary_history  basic salary with the date it took effect, so a
--                               raise mid-year never re-prices an older month.
--   hr_public_holidays          dates nobody is docked for not working; a
--                               company list, not the static calendar chrome in
--                               frontend/src/lib/holidays.ts.
--   hr_pay_rule_versions        shift / lateness / OT / statutory rates as dated
--                               snapshots; the rules for a day are the newest
--                               row on or before it (scm/shared/hr-pay-rules.ts).
-- Every table carries company_id: Houzs and 2990 keep separate staff and rules.

CREATE TABLE IF NOT EXISTS public.hr_employees (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id               bigint      NOT NULL,
  emp_no                   text        NOT NULL,
  name                     text        NOT NULL,
  user_id                  integer     REFERENCES public.users (id) ON DELETE SET NULL,
  department_id            integer     REFERENCES public.departments (id) ON DELETE SET NULL,
  position                 text,
  phone                    text,
  status                   text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'RESIGNED')),
  resigned_on              date,
  join_date                date,
  nationality              text,
  ic_number                text,
  passport_number          text,
  is_outsource             boolean     NOT NULL DEFAULT false,
  pay_mode                 text        NOT NULL DEFAULT 'MONTHLY' CHECK (pay_mode IN ('MONTHLY', 'DAILY')),
  basic_salary_sen         bigint      NOT NULL DEFAULT 0 CHECK (basic_salary_sen >= 0),
  daily_rate_sen           bigint      NOT NULL DEFAULT 0 CHECK (daily_rate_sen >= 0),
  working_hours_per_day    numeric(4,1) NOT NULL DEFAULT 9 CHECK (working_hours_per_day > 0 AND working_hours_per_day <= 24),
  working_days_per_month   integer     NOT NULL DEFAULT 26 CHECK (working_days_per_month BETWEEN 1 AND 31),
  ot_multiplier            numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (ot_multiplier >= 0),
  payment_method           text        NOT NULL DEFAULT 'TRANSFER' CHECK (payment_method IN ('TRANSFER', 'CASH')),
  bank_name                text,
  bank_account             text,
  epf_enabled              boolean     NOT NULL DEFAULT false,
  socso_enabled            boolean     NOT NULL DEFAULT false,
  eis_enabled              boolean     NOT NULL DEFAULT false,
  pcb_enabled              boolean     NOT NULL DEFAULT false,
  tax_residency            text        CHECK (tax_residency IN ('RESIDENT', 'NON_RESIDENT')),
  tax_category             text        CHECK (tax_category IN ('SINGLE', 'MARRIED_SPOUSE_NOT_WORKING', 'MARRIED_SPOUSE_WORKING')),
  tax_child_relief_sen     bigint      CHECK (tax_child_relief_sen >= 0),
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               integer,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               integer,
  CONSTRAINT hr_employees_resigned_on CHECK ((status = 'RESIGNED') = (resigned_on IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_emp_no ON public.hr_employees (company_id, upper(emp_no));
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_employees_user ON public.hr_employees (company_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.hr_employee_salary_history (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        bigint      NOT NULL,
  employee_id       bigint      NOT NULL REFERENCES public.hr_employees (id) ON DELETE CASCADE,
  basic_salary_sen  bigint      NOT NULL CHECK (basic_salary_sen >= 0),
  effective_from    date        NOT NULL,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        integer,
  CONSTRAINT uq_hr_salary_history_date UNIQUE (employee_id, effective_from)
);

CREATE TABLE IF NOT EXISTS public.hr_public_holidays (
  company_id    bigint      NOT NULL,
  holiday_date  date        NOT NULL,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    integer,
  PRIMARY KEY (company_id, holiday_date)
);

CREATE TABLE IF NOT EXISTS public.hr_pay_rule_versions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      bigint      NOT NULL,
  effective_from  date        NOT NULL,
  rules           jsonb       NOT NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      integer,
  CONSTRAINT uq_hr_pay_rule_versions_date UNIQUE (company_id, effective_from)
);

-- Kept off the PostgREST anon / authenticated roles: salaries and bank
-- accounts. RLS deliberately not enabled (prod Hyperdrive role not named in
-- this repo, see 0191).
REVOKE ALL ON public.hr_employees, public.hr_employee_salary_history, public.hr_public_holidays, public.hr_pay_rule_versions FROM PUBLIC;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
  REVOKE ALL ON public.hr_employees, public.hr_employee_salary_history, public.hr_public_holidays, public.hr_pay_rule_versions FROM anon;
END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
  REVOKE ALL ON public.hr_employees, public.hr_employee_salary_history, public.hr_public_holidays, public.hr_pay_rule_versions FROM authenticated;
END IF; END $$;
