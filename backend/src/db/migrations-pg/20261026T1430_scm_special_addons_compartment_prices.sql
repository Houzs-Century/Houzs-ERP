-- 20261026T1430_scm_special_addons_compartment_prices.sql
-- REVERSAL: ALTER TABLE scm.special_addons DROP COLUMN IF EXISTS compartment_prices;
--   Revert the code first (shared mfg-pricing specialAddonBaseSellingSen, the
--   /special-addons compartmentPrices field, loadSpecialAddons). Every add-on
--   then prices at its base again on every sofa; history snapshots keep the
--   field as inert JSON.
--   GRANTS: none to re-apply — a column and its CHECK ride the table's grants.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- column with a constant default, so every existing add-on reads [] — one price
-- on every sofa, exactly as today. No row is written, and a constant DEFAULT is
-- a catalogue-only change, so the table is not rewritten. The CHECK holds for
-- every row the moment the column exists.
--
-- WHY (2990 owner 2026-10-26): a sofa add-on can be priced by the build's
-- compartments, like the per-compartment fabric prices — a Latex Seat costs more
-- on a sofa with a corner (CNR). Entries are {compartment, sellingPriceSen},
-- canonical compartment codes; on a build that carries a listed compartment the
-- highest listed price replaces the base (shared specialAddonBaseSellingSen,
-- which the 2990 POS and the SO recompute both run, so the drift gate agrees).
-- Selling only: cost_price_sen is untouched.

SET search_path = public, scm;

ALTER TABLE scm.special_addons
  ADD COLUMN IF NOT EXISTS compartment_prices jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT special_addons_compartment_prices_array CHECK (jsonb_typeof(compartment_prices) = 'array');

COMMENT ON COLUMN scm.special_addons.compartment_prices IS
  'Detect by compartment: [{compartment, sellingPriceSen}] (canonical codes). On a sofa build that carries a listed compartment, the highest listed price replaces selling_price_sen. Empty = one price on every sofa. Selling only.';
