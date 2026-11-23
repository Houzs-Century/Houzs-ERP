-- 20261123T1210_scm_so_product_changes_rebuilt.sql
--
-- REVERSAL: revert the code first (backend/scripts/backfill-so-product-changes.mjs,
--   the Estimated mark in the Product changes reports). Then:
--     DELETE FROM scm.so_product_changes WHERE rebuilt;  -- only to take the backfill out
--     ALTER TABLE scm.so_product_changes DROP COLUMN IF EXISTS cost_estimated, DROP COLUMN IF EXISTS rebuilt;
--   GRANTS: none to re-apply. The columns ride their table's grants; this file
--   grants nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: two boolean
-- columns on scm.so_product_changes, NOT NULL DEFAULT false (a constant default:
-- no table rewrite). Every row the live record has written reads false on both,
-- which is what each one is.
--
-- WHY (owner 2026-11-23: 「补，从 9 月开始」). The record only starts when it goes
-- live; the months before it are rebuilt from each order's own history by
-- backend/scripts/backfill-so-product-changes.mjs.
--   rebuilt         the row was rebuilt from the order's history, not written when
--                   the change was saved or approved.
--   cost_estimated  a changed line's cost was not in the history (never stamped,
--                   or a deleted line whose cost was not logged) and was taken from
--                   the product's own cost; the reports mark the row Estimated.
-- Verified against: the table as 20261123T1205_scm_so_product_changes.sql creates it.

SET search_path = public, scm;

ALTER TABLE scm.so_product_changes
  ADD COLUMN IF NOT EXISTS rebuilt boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cost_estimated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scm.so_product_changes.rebuilt IS
  'Rebuilt from the order''s history by backfill-so-product-changes.mjs, not written when the change was saved.';
COMMENT ON COLUMN scm.so_product_changes.cost_estimated IS
  'A changed line''s cost was not in the history and was taken from the product''s own cost.';

NOTIFY pgrst, 'reload schema';
