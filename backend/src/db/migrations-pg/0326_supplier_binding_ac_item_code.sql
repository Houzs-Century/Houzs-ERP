-- ----------------------------------------------------------------------------
-- RE-CHECK NUMBER AT MERGE — parallel PRs; last on main was 0325 when written.
--
-- 0326 — the account book's name for an item stops sharing a column with the
--        supplier's.
--
-- WHY. `scm.supplier_material_bindings.supplier_sku` is read by TWO different
-- questions, and each believes the column is its own:
--
--   frontend/src/vendor/scm/lib/supplier-doc-data.ts:263
--       the bold "Supplier Code" on the PO / GRN / PI the SUPPLIER acts on
--   backend/src/services/autocount-item-code.ts:178
--       "supplier_sku is the AutoCount one" — the ItemCode written into the
--       licensed account book
--
-- The second reader was attached on 2026-08-11 (#2031) to a column that already
-- belonged to purchasing. Whichever answer is stored, the other reader is wrong.
--
-- MEASURED 2026-08-25, all 3,076 bindings, with the real resolver
-- (scripts/ac-item-code-census.mjs):
--
--     IN BOOK     1874
--     WOULD OPEN  1063   the book does not hold this code, so it gets OPENED
--     REFUSED      139   every one `ambiguous: … none belongs to supplier`
--
-- and the rule the working rows follow is exact: a binding whose value IS an
-- ItemCode the book holds wins outright (`index.acCodes.has(bound)`), with no
-- ambiguity and nothing opened. Hookka's 50 working bedframes carry
-- `HOK-1019 (SK)`; the 139 refusals carry `1007-(K)` and the like, which the
-- book has never heard of.
--
-- ItemCode IS STOCK IDENTITY in AutoCount. Buying into one code and selling out
-- of another does not merely look untidy — the two balances never reconcile.
-- That is why this is a column and not a convention.
--
-- WHAT THIS FILE DOES, AND DELIBERATELY DOES NOT DO. It ADDs a nullable column
-- and nothing else. No backfill, no default, no constraint, no view change.
-- NULL means "no answer stored", which is exactly today's behaviour: the
-- resolver already falls back to the cutover snapshot. So this migration cannot
-- change a single document on its own — the seeding is a separate, reviewable
-- step with its own dry run, and the code change that reads it is a third.
-- A migration that silently altered what reaches a licensed account book is the
-- one thing this must not be.
--
-- REVERSAL: `ALTER TABLE scm.supplier_material_bindings DROP COLUMN ac_item_code;`
-- and it is genuinely safe while the column is unseeded, because NULL is the
-- no-op value: the resolver reads it only when non-empty, so an all-NULL column
-- changes nothing to drop. AFTER seeding it is NOT safe — dropping it throws
-- away the only record of what the account book calls each product per supplier,
-- and the write-back silently falls back to purchasing's column, which is the
-- exact defect this file exists to end. Seed and drop are therefore separate
-- decisions, and the second one needs the seeded values exported first.
-- ----------------------------------------------------------------------------

ALTER TABLE scm.supplier_material_bindings
  ADD COLUMN IF NOT EXISTS ac_item_code text;

COMMENT ON COLUMN scm.supplier_material_bindings.ac_item_code IS
  'The ItemCode the AutoCount account book knows this product by, for this supplier. '
  'Read ONLY by the write-back resolver. NULL = no answer stored, fall back to the '
  'cutover snapshot. Never printed on a supplier document — that is supplier_sku, '
  'which this column exists to give back to purchasing (migration 0326).';

COMMENT ON COLUMN scm.supplier_material_bindings.supplier_sku IS
  'The code the SUPPLIER acts on, printed as "Supplier Code" on the PO / GRN / PI. '
  'Purchasing owns this column and may set it to whatever the supplier reads. '
  'It is NOT the AutoCount ItemCode — that is ac_item_code (migration 0326).';
