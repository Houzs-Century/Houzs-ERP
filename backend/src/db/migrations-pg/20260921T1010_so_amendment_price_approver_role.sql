-- 20260921T1010_so_amendment_price_approver_role.sql
-- Owner 2026-09-21: a 2990 price-only SO amendment (the PRICE lane, mig
-- 20260921T1000) signs with Finance (Kris), not the Purchaser. The approve gate
-- reads ROLE permissions (services/permissionHolders.ts), and permissions are
-- granted to ROLES by name (mig 0216 / 0225 / 20260909T1000). Kris shares the
-- 'Sales Director' role with Peter, so a plain grant to that role would let Peter
-- approve too. The owner's instruction is ONLY Kris.
--
-- This migration creates a dedicated role that clones 'Sales Director' and adds
-- scm.amendment.approve_price, so the single user placed on it approves 2990
-- price amendments while every other Sales Director does not. It does NOT
-- reassign the user: assigning a specific person is a Team > Roles action, and
-- their login e-mail is PII that must not live in this PUBLIC repo. See
-- tasks/TODO.md for the one-click follow-up.
--
-- CLONE, NOT INHERIT: the new role snapshots 'Sales Director' as it stands now;
-- a later edit to 'Sales Director' does not flow through. That is the standing
-- cost of a single-person grant in a role-based system (there is no per-user
-- permission store — hydrateAuthUser adds nothing per user). Keep the two in
-- step by hand if the Sales Director role changes.
--
-- The Owner role also gets the literal key, exactly as mig 20260909T1000 did for
-- the other approver keys, so the owner's shared account can step in when Kris is
-- away and lands on the notice + count (both exclude the '*' wildcard).
--
-- Idempotent: 'roles.name' has no unique constraint, so the clone is guarded by
-- NOT EXISTS; the Owner grant unions into a set that dedupes. permissions is a
-- TEXT column holding a JSON array (services/auth.ts parsePermissions).
--
-- REVERSAL: reassign anyone on the new role back to 'Sales Director' first, then
--   DELETE FROM public.roles WHERE name = 'Sales Director (Price Approver)';
--   UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT k)::text FROM jsonb_array_elements_text(permissions::jsonb) AS t(k) WHERE k <> 'scm.amendment.approve_price') WHERE name = 'Owner';

INSERT INTO public.roles (id, name, description, permissions, is_system, scope_to_pic)
SELECT
  (SELECT COALESCE(MAX(id), 0) + 1 FROM public.roles),
  'Sales Director (Price Approver)',
  'Sales Director who also approves 2990 price-only SO amendments (scm.amendment.approve_price). Clone of the Sales Director role plus the price key; keep in step by hand. Owner 2026-09-21.',
  (SELECT jsonb_agg(DISTINCT k ORDER BY k)::text FROM (
     SELECT jsonb_array_elements_text(sd.permissions::jsonb) AS k
     UNION SELECT 'scm.amendment.approve_price'
   ) u(k)),
  0,
  sd.scope_to_pic
FROM public.roles sd
WHERE sd.name = 'Sales Director'
  AND NOT EXISTS (SELECT 1 FROM public.roles WHERE name = 'Sales Director (Price Approver)')
ORDER BY sd.id
LIMIT 1;

-- Owner cover, mirroring mig 20260909T1000 for the other approver keys.
UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.amendment.approve_price'])
  ) AS u(k)
)
WHERE name = 'Owner' AND permissions IS NOT NULL;
