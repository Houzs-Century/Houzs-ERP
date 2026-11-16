-- 20261116T1000_so_amendment_addremove_lane_check.sql
-- Owner 2026-11-16: adding or cancelling a whole PRODUCT line on a processing-
-- locked Sales Order is now the Sales Director's to sign, not the Purchaser's
-- (a spec / colour / quantity change on an existing line still signs with the
-- Purchaser). At submit such a change carves into a new approval lane,
-- LINE_ADDREMOVE (shared/amendment-lane.ts), which — like LINES — raises the
-- follow-up PO Amendment on approval, but is signed with the Sales Director's
-- EXISTING scm.amendment.approve_price key. No new grant is needed: Peter / Kris
-- already hold that key on HOUZS and 2990, and Owner / Super Admin via "*". This
-- migration only WIDENS the lane CHECK so the new literal can be stored.
--
-- Houzs conventions (mirror 0216 / 20260921T1000): schema-qualified scm.*; NO
-- inner BEGIN/COMMIT (pg-migrate owns ONE transaction); DROP + re-ADD the CHECK,
-- idempotent on value so a re-run converges.
--
-- MIGRATION NUMBER taken as 20261116T1000 at branch time (latest was
-- 20261113T1600). Parallel PRs collide on numbers — RE-CHECK and renumber at
-- MERGE by re-listing the tree. Apply BEFORE deploying the dependent API code
-- (migrate-before-deploy).
--
-- REVERSAL: safe only once no row carries the new lane — a stored
-- 'LINE_ADDREMOVE' would fail the narrower CHECK:
--   ALTER TABLE scm.so_amendments DROP CONSTRAINT IF EXISTS so_amendments_lane_chk;
--   ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_lane_chk CHECK (lane IS NULL OR lane IN ('LINES','DELIVERY','PRICE'));

SET search_path = scm, public;

ALTER TABLE scm.so_amendments DROP CONSTRAINT IF EXISTS so_amendments_lane_chk;
ALTER TABLE scm.so_amendments ADD CONSTRAINT so_amendments_lane_chk CHECK (lane IS NULL OR lane IN ('LINES','DELIVERY','PRICE','LINE_ADDREMOVE'));
