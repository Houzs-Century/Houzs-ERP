-- 20261001T2330_payment_request_grant_roles.sql
-- Owner 2026-10-01: 现在给全部 active 的角色有这个 request a payment 的功能，除了
-- sales team — Finance, HR, IT, Management, Operation; then 可以, driver, helper
-- 不需要. So every role in use by an active member of those departments gets
-- `scm.payment_request.create` ("Request a payment (申请付款)",
-- services/permissions.ts):
--   Finance Department    — Finance, Finance Executive
--   HR Department         — HR
--   IT Department         — IT Admin
--   Operation Department  — BD Exec, Logistic, Ops Exec, Purchaser, Storekeeper
-- Not granted: Driver and Helper (his call), the Sales Department's roles (Sales
-- Person, Sales Director, Sales Director (Price Approver)), the roles nobody
-- active holds, and Owner / Super Admin, who carry "*" already.
-- Granted to each role by name, as 20261001T1300 does.
--
-- Idempotent: the key unions into a set that dedupes. permissions is a TEXT
-- column holding a JSON array (services/auth.ts parsePermissions); every one of
-- the nine reads as a JSON array on production (checked 2026-10-01).
-- Verified against: staging (minnapsemfzjmtvnnvdd) via MCP apply_migration on
--   2026-10-01; the key read back on the named roles in the PR body.
--
-- REVERSAL:
--   UPDATE public.roles SET permissions = (SELECT jsonb_agg(DISTINCT k)::text FROM jsonb_array_elements_text(permissions::jsonb) AS t(k) WHERE k <> 'scm.payment_request.create')
--   WHERE name IN ('Finance', 'Finance Executive', 'HR', 'IT Admin', 'BD Exec', 'Logistic', 'Ops Exec', 'Purchaser', 'Storekeeper');

UPDATE public.roles SET permissions = (
  SELECT jsonb_agg(DISTINCT k)::text FROM (
    SELECT jsonb_array_elements_text(permissions::jsonb) AS k
    UNION
    SELECT unnest(ARRAY['scm.payment_request.create'])
  ) AS u(k)
)
WHERE name IN ('Finance', 'Finance Executive', 'HR', 'IT Admin', 'BD Exec', 'Logistic', 'Ops Exec', 'Purchaser', 'Storekeeper')
  AND permissions IS NOT NULL;
