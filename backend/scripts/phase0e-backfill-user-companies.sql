-- ============================================================================
-- Phase 0e activation — backfill user_companies so the (already-built)
-- companyContext per-user enforcement kicks in.
--   companyContext.ts already reads user_companies FAIL-OPEN: a user with >=1
--   grant is restricted to their granted companies; a user with 0 grants (or an
--   absent table) falls back to ALL companies. So today (empty table) = everyone
--   sees both. Populating this table turns on real per-company visibility.
--
-- RULE (owner-confirmed 2026-07-14):
--   (1) every existing user belongs to Houzs (company 1)
--   (2) users with role Owner / Super Admin ALSO belong to 2990 (company 2) =
--       both, so owner/IT are never locked out. Keyed on ROLE NAME (roles.name),
--       NOT role_id — role_ids differ across staging/prod. users.role_id -> roles.
--       Staging (DB minnapsemfzjmtvnnvdd) applied 2026-07-14: 103 users -> Houzs,
--       4 -> both. Prod both-list PENDING owner confirm (weisiang329/nicochoong93/
--       hello@houzscentury.com/houzs.test.admin). << adjust IN(...) as owner says >>
--
-- APPLY ORDER: STAGING first (DB minnapsemfzjmtvnnvdd) -> verify the counts +
--   that a super_admin can switch to 2990 while a sales user cannot -> then PROD
--   (anogrigyjbduyzclzjgn). Idempotent (ON CONFLICT DO NOTHING) — safe to re-run.
-- ============================================================================

-- (1) everyone -> Houzs
INSERT INTO public.user_companies (user_id, company_id)
SELECT id, 1 FROM public.users
ON CONFLICT DO NOTHING;

-- (2) super_admin -> also 2990 (both companies)
INSERT INTO public.user_companies (user_id, company_id)
SELECT u.id, 2 FROM public.users u JOIN public.roles r ON r.id = u.role_id
 WHERE r.name IN ('Owner','Super Admin')
ON CONFLICT DO NOTHING;

-- verify
SELECT
  (SELECT count(*) FROM public.users)                                      AS total_users,
  (SELECT count(DISTINCT user_id) FROM public.user_companies)              AS users_with_grant,
  (SELECT count(*) FROM public.user_companies WHERE company_id = 1)        AS houzs_grants,
  (SELECT count(*) FROM public.user_companies WHERE company_id = 2)        AS both_grants,
  (SELECT string_agg(u.email, ', ')
     FROM public.users u JOIN public.user_companies uc ON uc.user_id = u.id
    WHERE uc.company_id = 2)                                               AS both_company_users;
