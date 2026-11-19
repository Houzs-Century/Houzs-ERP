-- 20261119T0900_hr_kpi_appraisal.sql
-- HC-0125 KPI appraisal: an in-ERP monthly KPI review for storekeeper
-- supervisors (and, same template, the storekeepers under them). A reviewer
-- rates each weighted KPI 1-5 per week; the month's final score falls in a
-- payout tier that pays a fixed RM by role, which is booked as that month's
-- KPI allowance (hr_allowances, kind 'KPI', already an allowed kind).
--
-- Three new tables, all company-scoped: hr_kpi_metrics (the editable KPI
-- lines), hr_kpi_tiers (the editable payout bands), hr_kpi_reviews (one
-- appraisal per employee per month; the weekly ratings live in a jsonb grid).
-- No seed data here (amounts are pay-sensitive and the repo is public): the
-- config is seeded per company from the app.
--
-- REVERSAL: DROP TABLE IF EXISTS public.hr_kpi_reviews;
--   DROP TABLE IF EXISTS public.hr_kpi_tiers;
--   DROP TABLE IF EXISTS public.hr_kpi_metrics;
--   (Safe: these tables are new; dropping them removes KPI appraisals only.
--   KPI allowance rows already booked into hr_allowances are NOT removed.)

CREATE TABLE IF NOT EXISTS public.hr_kpi_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  name text NOT NULL,
  target text NOT NULL DEFAULT '',
  weight_bp integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_kpi_metrics_company ON public.hr_kpi_metrics (company_id, sort_order);

CREATE TABLE IF NOT EXISTS public.hr_kpi_tiers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  min_score_x100 integer NOT NULL,
  max_score_x100 integer NOT NULL,
  label text NOT NULL,
  supervisor_amount_sen bigint NOT NULL DEFAULT 0,
  staff_amount_sen bigint NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hr_kpi_tiers_company ON public.hr_kpi_tiers (company_id, sort_order);

CREATE TABLE IF NOT EXISTS public.hr_kpi_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id bigint NOT NULL,
  employee_id bigint NOT NULL,
  period text NOT NULL,
  role text NOT NULL DEFAULT 'SUPERVISOR',
  status text NOT NULL DEFAULT 'DRAFT',
  scores jsonb NOT NULL DEFAULT '[]'::jsonb,
  final_score_x100 integer,
  tier_label text,
  amount_sen bigint,
  allowance_id bigint,
  reviewer_user_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_kpi_reviews_emp_period ON public.hr_kpi_reviews (company_id, employee_id, period);
