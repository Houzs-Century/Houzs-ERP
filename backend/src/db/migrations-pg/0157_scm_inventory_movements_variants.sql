-- 0157 — Stock Adjustment must record variants + special orders, like every
-- other SCM document (owner 2026-07-20).
--
-- The Stock Adjustment create form (StockAdjustmentNew) already sends the full
-- variants bag — variant axes plus any SPECIAL order (specials / specialChoices
-- / extraAddonNote) — but inventory-adjustments.ts only kept a `variant_key`
-- bucket string, so the special order the user entered was silently dropped and
-- never made it into a Description 2. Add the same two carriers every SCM line
-- table has: the raw jsonb bag (round-trips + editable) and the rendered
-- Description 2 (the "... / SPECIAL: ..." summary from buildVariantSummary).
--
-- Nullable, no default, no backfill: inventory_movements is the shared stock
-- ledger and only ADJUSTMENT rows populate these today; every other movement
-- type leaves them NULL. Adding nullable columns does not rewrite the table and
-- does not touch the FIFO / allocation triggers.

ALTER TABLE scm.inventory_movements
  ADD COLUMN IF NOT EXISTS variants     jsonb,
  ADD COLUMN IF NOT EXISTS description2  text;
