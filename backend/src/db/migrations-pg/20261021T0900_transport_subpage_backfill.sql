-- 20261021T0900_transport_subpage_backfill.sql
-- REVERSAL: DELETE FROM public.role_page_access
--   WHERE page_key IN ('scm.transportation.overview','scm.transportation.planning',
--     'scm.transportation.dp_orders','scm.transportation.last_mile',
--     'scm.transportation.lorry_map','scm.transportation.lorry_capacity',
--     'scm.transportation.crew_leave','scm.transportation.coverage');
--   Revert the code (services/pageAccess.ts) first so these keys leave the
--   catalogue; the rows then become inert (resolvePositionAccessFromRows filters
--   by isValidPageKey) and the DELETE merely tidies them. No grants to re-apply.
--
-- WHAT THIS CHANGES, and why it is a byte-for-byte no-op for every login today.
-- services/pageAccess.ts (RBAC rebuild batch 2) splits the Transportation area
-- into eight per-page page keys (scm.transportation.overview / .planning /
-- .dp_orders / .last_mile / .lorry_map / .lorry_capacity / .crew_leave /
-- .coverage), each a CHILD of scm.transportation.drivers. At login they inherit
-- their parent's resolved level, so no member's access changes on deploy
-- (transportSubpageSplit.test.ts pins this). This migration writes the SAME value
-- as an explicit row per role, copied from that role's existing
-- scm.transportation.drivers row.
--
-- WHY PARENT = scm.transportation.drivers, NOT scm.transportation. Prod
-- (anogrigyjbduyzclzjgn, 2026-10-21) holds only three transportation shapes
-- across 24 roles: transportation=full / drivers=full (11), none / none (9), and
-- transportation=view / drivers=view (4 — scm umbrella off, may only SEE the
-- pages). drivers resolves EQUAL to its parent scm.transportation in every shape,
-- so neither parent would over-grant; parenting on the drivers leaf follows the
-- same money/stock-safety rule as the Finance batch (never inherit above the key
-- the pages actually carry) and keeps the mapping faithful.
--
-- WHY THE EXPLICIT ROWS ARE NEEDED (not just the cascade). PR1 seeded every role
-- a COMPLETE row set (one row per catalogue key). The role matrix (PR2) and the
-- Excel import (PR3) both PATCH a role's ENTIRE page-access set (replace-set):
-- any catalogue key missing a staged row is re-persisted as `none`. A new key
-- with no stored row would therefore be written `none` the next time the owner
-- saves ANY role — silently hiding the transportation pages he did not touch.
-- Backfilling the row keeps the invariant "every role has a row for every key",
-- so the matrix loads each new key at its real (inherited) level and a save
-- round-trips it unchanged.
--
-- WHY COPY FROM scm.transportation.drivers, not recompute. The owner is actively
-- re-configuring roles; recomputing from the position policy would clobber his
-- hand edits. Copying the role's CURRENT drivers level preserves exactly what
-- each role holds today: the 11 full-transportation roles -> full, the 4 see-only
-- roles -> view, the 9 none-roles -> none. ON CONFLICT DO NOTHING makes a re-run
-- idempotent and never overwrites a value the owner later sets explicitly.
-- RE-RUN: safe (idempotent) — only inserts a (role, new-key) pair that is absent.

INSERT INTO public.role_page_access (role_id, page_key, level, created_at, updated_at)
SELECT a.role_id, k.page_key, a.level,
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
       to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
FROM public.role_page_access a
CROSS JOIN (VALUES
  ('scm.transportation.overview'),
  ('scm.transportation.planning'),
  ('scm.transportation.dp_orders'),
  ('scm.transportation.last_mile'),
  ('scm.transportation.lorry_map'),
  ('scm.transportation.lorry_capacity'),
  ('scm.transportation.crew_leave'),
  ('scm.transportation.coverage')
) AS k(page_key)
WHERE a.page_key = 'scm.transportation.drivers'
ON CONFLICT (role_id, page_key) DO NOTHING;
