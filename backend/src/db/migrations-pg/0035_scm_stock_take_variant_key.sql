-- 0035_scm_stock_take_variant_key.sql — port of 2990 migration 0183.
--
-- Stock take: count + adjust PER (product_code, variant_key).
--
-- BUG-2026-06-20-008 #15 (HIGH, data corruption): the count snapshot was the
-- SKU TOTAL across all variants (v_inventory_all_skus, which SUMs variant_key),
-- but the posted ADJUSTMENT carried NO variant_key, so it defaulted to the ''
-- bucket. For any attributed SKU (sofa / bedframe / mattress) this corrupted
-- per-variant on-hand + valuation: the real variant bucket kept its qty while a
-- phantom adjustment landed in '' (where FIFO finds no lots → no COGS write-off).
--
-- Fix: the count sheet is now built per (product_code, variant_key) from
-- scm.inventory_balances (variant-grained), and the post stamps variant_key on
-- the ADJUSTMENT so it lands in the bucket it measured. (The route also re-reads
-- LIVE on-hand at post so the result is exactly the counted qty — this also
-- supersedes the stale-snapshot reconcile.)
--
-- Additive + idempotent — safe to apply before the code deploys (existing rows
-- get variant_key='' and behave exactly as before until the new code runs).
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); each statement ends ';'+newline with no internal ';\n'.
ALTER TABLE scm.stock_take_lines ADD COLUMN IF NOT EXISTS variant_key   TEXT NOT NULL DEFAULT '';
ALTER TABLE scm.stock_take_lines ADD COLUMN IF NOT EXISTS variant_label TEXT;
DROP INDEX IF EXISTS scm.stock_take_lines_take_product_unique;
CREATE UNIQUE INDEX IF NOT EXISTS stock_take_lines_take_product_variant_unique ON scm.stock_take_lines (stock_take_id, product_code, variant_key);
