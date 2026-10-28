-- 0225_legacy_amendment_approver_grants.sql
-- Owner 2026-07-29 ("B", re-confirmed 写入): let the Purchasing + Logistics
-- desks clear LEGACY (pre-two-lane, lane IS NULL) SO amendments themselves.
--
-- WHY
--   The 7-27 two-lane rework (mig 0216) granted the desks the NEW lane keys
--   (approve_lines / approve_delivery) — but rows raised BEFORE the rework keep
--   the ORIGINAL supplier-confirmed two-gate chain, whose gates check the OLD
--   keys: scm.amendment.supplier_confirm then scm.amendment.approve_so
--   (so-amendments.ts routes legacy NULL-lane rows to those keys on purpose).
--   Nobody but Owner / Super Admin ("*") and the IT Admin roles held them, so
--   the surviving legacy rows (2 REQUESTED as of 2026-07-29: SO-2607-015/A1,
--   SO-2607-018/A1) dead-ended for every daily approver — the owner had to
--   clear 2990-SO-2606-049/A1 personally. Legacy rows are a CLOSED set (no new
--   NULL-lane row can be created), so these grants drain a finite backlog
--   rather than widening the steady-state model: on lane rows the
--   supplier-confirm gate answers not_in_lane_flow and approve-so resolves the
--   LANE key, so the old keys are inert outside the legacy chain.
--
-- Same conventions as 0216: roles are is_system=1 (the Roles UI refuses
-- permission edits) so a migration is the sanctioned channel; target by NAME
-- (ids drift between environments — prod Purchaser = 330 live + 322 stale
-- 0-user duplicate, Logistic = 323); public. qualified; jsonb union dedupes so
-- a re-run converges; permissions is a TEXT column holding a JSON array.

UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.amendment.supplier_confirm', 'scm.amendment.approve_so'])
  ) AS u(k)
)
WHERE name IN ('Purchaser', 'Logistic') AND permissions IS NOT NULL;
