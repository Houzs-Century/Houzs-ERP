-- 20261012T1210_grant_purchaser_override_po_processing_date.sql
-- BUG-101, Sim (Purchaser) 2026-10-12: once an SO has a PO, only the Purchaser
-- may change its Processing Date — "Only the purchaser has the authority to
-- personally handle issues that arise; delegating this task to sales staff would
-- increase the purchaser workload." So `scm.so.override_po_processing_date`
-- (services/permissions.ts) goes to the Purchaser role and no other. Owner /
-- Super Admin carry "*" already. Everyone else, sales included, is refused at
-- submit (shared/so-po-date-rule.ts).
-- Granted by role name, as 20261001T2330 does.
--
-- Idempotent: the key unions into a set that dedupes. permissions is a TEXT
-- column holding a JSON array (services/auth.ts parsePermissions).
--
-- REVERSAL:
--   UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT k)::text FROM jsonb_array_elements_text(permissions::jsonb) AS t(k) WHERE k <> 'scm.so.override_po_processing_date')
--   WHERE name = 'Purchaser';

UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.so.override_po_processing_date'])
  ) AS u(k)
)
WHERE name = 'Purchaser'
  AND permissions IS NOT NULL;
