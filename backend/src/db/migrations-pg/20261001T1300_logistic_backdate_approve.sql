-- 20261001T1300_logistic_backdate_approve.sql
-- Owner 2026-09-30: Logistic also decides SO payment backdate requests (a slip
-- older than 14 days, keyed as a request — mig 20260930T1500), but only DECIDES:
-- a Logistic user's own late slip still goes through a request. So the role gets
-- the approve-only key `scm.payment.backdate.approve`, not `scm.payment.backdate`.
-- Granted to the role by name, as 20260925T1200 does.
--
-- Idempotent: the key unions into a set that dedupes. permissions is a TEXT
-- column holding a JSON array (services/auth.ts parsePermissions).
--
-- REVERSAL:
--   UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT k)::text FROM jsonb_array_elements_text(permissions::jsonb) AS t(k) WHERE k <> 'scm.payment.backdate.approve') WHERE name = 'Logistic';

UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.payment.backdate.approve'])
  ) AS u(k)
)
WHERE name = 'Logistic' AND permissions IS NOT NULL;
