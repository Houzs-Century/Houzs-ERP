-- 20261021T0930_team_service_subpage_backfill.sql
-- REVERSAL: DELETE FROM public.role_page_access
--   WHERE page_key = 'team.mailboxes';
--   team.mailboxes is the ONLY key this migration creates rows for. The other
--   wired keys (team.members / team.roles / team.org_chart / team.departments /
--   service_cases.settings) already carried a complete row set per role before
--   this ran, so every INSERT for them hit ON CONFLICT DO NOTHING and added
--   nothing to reverse. Revert the code (services/pageAccess.ts — the five keys
--   return to DORMANT_PAGE_KEYS; Sidebar.tsx repoints the Team leaves back to
--   `team` and drops service_cases.settings from Service Maintenance) FIRST; the
--   team.mailboxes rows then become inert (the catalogue no longer has that key,
--   resolvePositionAccessFromRows filters by isValidPageKey) and the DELETE
--   merely tidies them. No grants to re-apply.
--
-- WHAT THIS CHANGES, and why it is a byte-for-byte no-op for every login today.
-- services/pageAccess.ts (RBAC rebuild batch 3, owner 2026-10-20 "全部拆开")
-- gives each Team sub-page and the Service Maintenance tab its own page key:
--   * team.members / team.roles / team.org_chart / team.departments — four keys
--     that ALREADY existed in the catalogue as DORMANT (declared, settable, read
--     by nothing). This batch leaves them dormant and repoints the Team nav rows
--     (Directory / Roles & Permissions / Org Chart / Departments) off the parent
--     `team` onto them.
--   * team.mailboxes — the ONE genuinely new key, backing the Team Mailboxes tab.
--   * service_cases.settings — also previously DORMANT, now wired onto the
--     Service Maintenance tab (ANDed with its existing service_cases.manage perm).
-- All are children of their area parent (team / service_cases), so at login they
-- inherit the parent's resolved level — no member's access changes on deploy
-- (teamServiceSubpageSplit.test.ts pins this). This migration writes the SAME
-- value as an explicit row per role, copied from that role's existing parent row.
--
-- WHY PARENT = team / service_cases (the area parent), NOT a leaf. Unlike the
-- Finance / Transportation batches — where a "view-only" cohort sat UNDER the
-- area key and parenting on the area would have over-granted — the Team and
-- Service areas have no such intermediate leaf, and prod (anogrigyjbduyzclzjgn,
-- 2026-10-21) confirms there is nothing to over-grant: all 24 roles store each
-- team.* child EXACTLY EQUAL to their `team` row (14 full, 10 none), and the only
-- role whose service_cases.settings sits below its service_cases parent
-- (PG WH Assistant: parent partial, settings none) does NOT hold
-- service_cases.manage, so the ANDed perm gate already hides Service Maintenance
-- from it and nothing changes. Copying the parent level is therefore both the
-- faithful mapping and the zero-change one.
--
-- WHY THE EXPLICIT ROWS ARE NEEDED (not just the cascade). PR1 seeded every role
-- a COMPLETE row set (one row per catalogue key). The role matrix (PR2) and the
-- Excel import (PR3) both PATCH a role's ENTIRE page-access set (replace-set):
-- any catalogue key missing a staged row is re-persisted as `none` on the next
-- save. The new key team.mailboxes has no stored row yet, so without this backfill
-- the owner's next save of ANY role would silently write it `none` and hide the
-- Mailboxes tab. Backfilling the row keeps the invariant "every role has a row for
-- every key", so the matrix loads team.mailboxes at its real (inherited) level and
-- a save round-trips it unchanged. The other five keys already satisfy the
-- invariant; their INSERTs are defensive no-ops (they fill a row only on an
-- environment that is somehow missing one, and ON CONFLICT DO NOTHING never
-- touches a row that exists).
--
-- WHY COPY FROM the parent, not recompute. The owner is actively re-configuring
-- roles; recomputing from the position policy would clobber his hand edits.
-- Copying the role's CURRENT parent level preserves exactly what each role holds
-- today. ON CONFLICT DO NOTHING makes a re-run idempotent and — crucially — means
-- this migration can NEVER lower or raise an existing row (e.g. it leaves
-- PG WH Assistant's service_cases.settings = none untouched); it only adds a
-- missing (role, key) pair.
-- RE-RUN: safe (idempotent) — only inserts a (role, new-key) pair that is absent.

-- Team sub-pages <- each role's current `team` level.
INSERT INTO public.role_page_access (role_id, page_key, level, created_at, updated_at)
SELECT a.role_id, k.page_key, a.level,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
FROM public.role_page_access a
CROSS JOIN (VALUES
  ('team.members'),
  ('team.roles'),
  ('team.org_chart'),
  ('team.departments'),
  ('team.mailboxes')
) AS k(page_key)
WHERE a.page_key = 'team'
ON CONFLICT (role_id, page_key) DO NOTHING;

-- Service Maintenance <- each role's current `service_cases` level.
INSERT INTO public.role_page_access (role_id, page_key, level, created_at, updated_at)
SELECT a.role_id, 'service_cases.settings', a.level,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
FROM public.role_page_access a
WHERE a.page_key = 'service_cases'
ON CONFLICT (role_id, page_key) DO NOTHING;
