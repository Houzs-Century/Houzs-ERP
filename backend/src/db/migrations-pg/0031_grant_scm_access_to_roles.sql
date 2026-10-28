-- 0031_grant_scm_access_to_roles.sql
--
-- Grant the new `scm.access` permission (added to the catalogue in
-- backend/src/services/permissions.ts) to the two non-admin roles that
-- need the furniture Supply Chain modules:
--
--   * role 322  Purchaser   — currently ["projects.read","projects.checklist.tick","projects.write"]
--   * role 326  Storekeeper — currently ["projects.read"]
--
-- Owner (role 1) and IT Admin (role 7) hold "*" and already pass the
-- re-gated /api/scm/* mount (requireAnyPermission(["*","scm.access"]))
-- and the /scm/* frontend guards, so they are intentionally NOT touched.
--
-- roles.permissions is a TEXT column holding a JSON array as text (default
-- '[]'), so we cast to jsonb to append, then cast back to text to store.
-- The jsonb @> guard makes this idempotent: re-running is a no-op once
-- scm.access is present, and it never clobbers any other perm the owner may
-- have added by hand. No inner BEGIN/COMMIT (the runner owns the txn).

UPDATE roles
   SET permissions = ((permissions::jsonb) || '["scm.access"]'::jsonb)::text
 WHERE id IN (322, 326)
   AND NOT ((permissions::jsonb) @> '"scm.access"'::jsonb);
