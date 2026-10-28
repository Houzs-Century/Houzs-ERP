-- ─────────────────────────────────────────────────────────────────────────
-- Phase 0e — per-company user access grants.
--
-- APPLIED IN PROD. The paragraph that used to sit here said "STAGED — do NOT
-- move this file into migrations-pg/ until Phase 0f", and it survived the very
-- commit that moved it (0c3b35e, "multicompany: ACTIVATE … Phase 0f"). It read
-- as an unshipped staging note for weeks after the table went live, which cost
-- a reviewer real time on 2026-07-16 — a comment that lies about where the code
-- runs is worse than no comment.
--
-- So, plainly: this table is LIVE. Per-user company gating is ON in prod. Every
-- request resolves grants through companyContext, and admins can already create
-- them via User Management (routes/users.ts setUserCompanies). Anything that
-- reads a company for a restricted user is a live authorization path, not a
-- dormant Phase-0f one.
--
-- Mirrors user_brands (mig 049): a per-user allow-list, replace-set semantics.
-- Composite PK (user_id, company_id) makes each grant unique; the extra index
-- on user_id speeds the per-request lookup in companyContext.
--
-- FK types match the referenced PKs exactly:
--   public.users.id      -> serial  (int4 / integer)
--   public.companies.id  -> bigint identity (int8 / bigint)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_companies (
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id bigint NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_user_companies_user ON public.user_companies (user_id);
