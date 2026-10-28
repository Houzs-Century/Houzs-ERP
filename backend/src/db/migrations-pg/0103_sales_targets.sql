-- 0103_sales_targets.sql — create the Sales Analysis marketing target profile
-- table (scm.analysis_customer_targets) on PROD for the ported /sales-analysis
-- route (backend/src/scm/routes/sales-analysis.ts → PUT /targets writes it, GET
-- reads it). Absent from Houzs until now (2990 had it as an id=1 singleton).
--
-- Houzs port conventions (mirrors 0090):
--   * schema-qualified to scm.*; NO inner BEGIN/COMMIT (pg-migrate owns the txn);
--     plain additive DDL, CREATE TABLE IF NOT EXISTS (idempotent / re-run-safe).
--   * PER-COMPANY: keyed by company_id (bigint NOT NULL, FK public.companies) so
--     each merged company keeps its OWN target profile — one row per company
--     (company_id is the primary key). The route reads via scopeToCompany and
--     upserts onConflict company_id.
--   * jsonb for the race/gender share maps; text[] for the area lists.
--   * updated_by kept text (stores the real Houzs user id as text; no FK — the
--     SCM bridge pins scm.staff, so a staff FK would be meaningless).
--   * RLS stripped (Houzs guards in the route + service-role key).

CREATE TABLE IF NOT EXISTS scm.analysis_customer_targets (
  company_id     bigint PRIMARY KEY REFERENCES public.companies(id),
  age_range_min  integer,
  age_range_max  integer,
  race_targets   jsonb,
  gender_targets jsonb,
  area_states    text[] NOT NULL DEFAULT '{}',
  area_cities    text[] NOT NULL DEFAULT '{}',
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);
