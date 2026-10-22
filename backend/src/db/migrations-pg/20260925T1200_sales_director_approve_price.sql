-- 20260925T1200_sales_director_approve_price.sql
-- Owner 2026-09-25: a price-only SO amendment now takes the PRICE lane on HOUZS
-- as well as 2990 (shared/amendment-lane.ts PRICE_LANE_COMPANY_CODES), and every
-- Sales Director signs it, not only the one placed on 'Sales Director (Price
-- Approver)' (mig 20260921T1010). Grant the key to the 'Sales Director' role by
-- name. Permissions are not per company, so this also lets that role sign 2990
-- price amendments — the owner accepted that.
--
-- Idempotent: the key unions into a set that dedupes. permissions is a TEXT
-- column holding a JSON array (services/auth.ts parsePermissions).
--
-- REVERSAL:
--   UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT k)::text FROM jsonb_array_elements_text(permissions::jsonb) AS t(k) WHERE k <> 'scm.amendment.approve_price') WHERE name = 'Sales Director';

UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.amendment.approve_price'])
  ) AS u(k)
)
WHERE name = 'Sales Director' AND permissions IS NOT NULL;
