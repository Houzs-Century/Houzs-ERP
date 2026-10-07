-- 20261007T1200_scm_product_model_default_variants.sql
-- REVERSAL: ALTER TABLE scm.product_models DROP COLUMN IF EXISTS default_variants;
--   Revert the code first: routes/product-models.ts (COLS + PATCH) and the
--   mfg-products catalog join select the column.
--   GRANTS: none to re-apply — a column rides its table's grants.
--
-- WHAT THIS CHANGES: one new column on scm.product_models,
--   default_variants jsonb NOT NULL DEFAULT '{}' — the variant a new Sales Order
--   line starts with when this Model's SKU is picked, keyed like a line's
--   variants (seatHeight, legHeight, divanHeight, gap). Every existing row reads
--   '{}' (no default), so nothing changes until someone sets one.
--
-- WHY (Weisiang 2026-10-07): each Model should carry a default variant per
-- option on top of its allowed options, so the SO line pre-fills it.

ALTER TABLE scm.product_models
  ADD COLUMN IF NOT EXISTS default_variants jsonb NOT NULL DEFAULT '{}'::jsonb;
