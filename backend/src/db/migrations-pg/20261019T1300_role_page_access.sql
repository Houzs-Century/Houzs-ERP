-- 20261019T1300_role_page_access.sql
-- REVERSAL: DROP TABLE IF EXISTS public.role_page_access;
--   Revert the code first: services/memberPageAccess.ts falls back to the
--   position policy / permission backfill for any role with NO rows, so with the
--   code at the commit before this one the table is simply unread. The ROWS are
--   recomputable at any time from the live policy by re-running
--   scripts/seed-role-page-access.mjs, so none are lost by dropping the table.
--   GRANTS: none to re-apply — the table rides public's default privileges
--   (service_role), like roles / user_brands.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new EMPTY
-- table and its implicit primary-key index. No existing row is written or
-- altered, and no reader is forced on: hydrateAuthUser only consults these rows
-- when a role HAS them, and falls back to exactly today's resolution otherwise.
-- So an empty table (the state right after this migration) is a byte-for-byte
-- no-op for every member. The row seed is a separate, audited script run by hand
-- after deploy (scripts/seed-role-page-access.mjs, plan/apply/CONFIRM).
--
-- WHY (RBAC rebuild, Option A — owner-approved). Page visibility had no table:
-- it was derived at login (resolvePositionPolicy for a titled member, the
-- permission backfill for a title-less one) and the owner could not SET it. The
-- old role_page_access was dropped on 2026-09-17 (20260917T0900) once no
-- title-less member remained. This recreates it as the persistent per-role page
-- layer that PR2's matrix UI writes to and the owner edits down to sub-page
-- granularity. The shape is the old one verbatim (composite PK (role_id,
-- page_key); level is free TEXT so every level the resolver understands —
-- none / partial / view / edit / full — round-trips without a lossy CHECK).
-- FK role_id -> roles(id) ON DELETE CASCADE: deleting a role takes its rows with
-- it (a role's page grants are meaningless without the role).

CREATE TABLE IF NOT EXISTS public.role_page_access (
  role_id    integer NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  page_key   text NOT NULL,
  level      text NOT NULL,
  created_at text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at text DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  CONSTRAINT role_page_access_role_id_page_key_pk PRIMARY KEY (role_id, page_key)
);
