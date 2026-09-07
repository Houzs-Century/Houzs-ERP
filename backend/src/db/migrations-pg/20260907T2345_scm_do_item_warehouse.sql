-- 20260907T2345_scm_do_item_warehouse.sql
-- Give a DELIVERY LINE the warehouse its goods actually left from.
--
-- WHY. AutoCount records a Location on every DODTL row — `HQ`, `PG`, `KL`,
-- `SRW`, `SBH` — and the ERP had nowhere to put it. Measured against production
-- 2026-09-07 23:06+08: scm.delivery_order_items has 38 columns and NOT ONE of
-- them names a warehouse, a location or a branch (`rack_id` is the only
-- warehouse-adjacent column, and it is filled on 0 of 1,007 rows). The
-- reconcile therefore reported the book's per-line location as
-- `line location [NOT-C]` — a value the book states and no importer carries.
--
-- THE OWNER'S RULING, 2026-09-07: 「HQ PGG 就是我们的 stock warehouse location。
-- 就是 warehouse location」. So this is NOT a new concept and this migration does
-- NOT invent a second one. `warehouse_id` is the same uuid every other line
-- table already uses (mfg_sales_order_items.warehouse_id, mig 0118;
-- purchase_order_items.warehouse_id), resolved through the SHARED
-- AutoCount-location map in `backend/scripts/lib/ac-stock-compare.mjs`
-- (SALESLOC). `location` is the book's raw code beside it — the same PAIR the
-- sales-order line already carries, so a reconcile can compare the text the book
-- wrote without re-deriving it from a uuid, and an unmappable code is visible
-- rather than silently absent.
--
-- WHY THE ERP DID NOT ALREADY KNOW. It half did, and that is the trap.
-- `resolveDoLineWarehouses` (routes/delivery-orders-mfg.ts) RESOLVES a warehouse
-- per line at read time — SO line -> DO header -> company default — and the
-- detail endpoint stamps `warehouse_id` + `warehouse_code` onto every item. That
-- inference is right on 363 of the 366 book delivery lines that carry a location
-- and WRONG on 3: `DO-000097` shipped from `HQ` against a `PG` sales-order line.
-- A derived warehouse that is right 99.2% of the time is exactly the thing worth
-- storing, because nothing about the answer says which 0.8% it is.
--
-- NO BACKFILL HERE. The column arrives NULL everywhere and every read path
-- falls back to the resolution it uses today, so this file changes no behaviour
-- on its own. The 82 migrated delivery documents the book cut can speak for are
-- filled by `backend/scripts/backfill-do-line-warehouse.mjs`, dispatched
-- separately, plan by default.
--
-- REVERSAL:
--   ALTER TABLE scm.delivery_order_items DROP COLUMN IF EXISTS warehouse_id;
--   ALTER TABLE scm.delivery_order_items DROP COLUMN IF EXISTS location;
--   DROP INDEX IF EXISTS scm.idx_scm_do_items_warehouse_id;
-- Both columns are additive and nullable, no NOT NULL, no default, no view and
-- no trigger reads them, so the drop is complete — nothing else has to be put
-- back. The FK is ON DELETE SET NULL, so dropping it cannot cascade.

SET search_path = scm, public;

ALTER TABLE scm.delivery_order_items ADD COLUMN IF NOT EXISTS warehouse_id uuid;
ALTER TABLE scm.delivery_order_items ADD COLUMN IF NOT EXISTS location text;

DO $$ BEGIN ALTER TABLE scm.delivery_order_items ADD CONSTRAINT delivery_order_items_warehouse_id_fkey FOREIGN KEY (warehouse_id) REFERENCES scm.warehouses(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_scm_do_items_warehouse_id
  ON scm.delivery_order_items (warehouse_id) WHERE warehouse_id IS NOT NULL;

COMMENT ON COLUMN scm.delivery_order_items.warehouse_id IS
  'The warehouse this line''s goods actually left from. NULL means "not stated" and the reader falls back to resolveDoLineWarehouses (SO line -> DO header -> company default) exactly as before. Filled for migrated documents from AutoCount DODTL.Location through the shared SALESLOC map; owner ruling 2026-09-07 that HQ/PG/KL/SRW/SBH ARE these warehouses.';
COMMENT ON COLUMN scm.delivery_order_items.location IS
  'AutoCount DODTL.Location verbatim, beside the resolved warehouse_id — the same raw-code + uuid pair mfg_sales_order_items already carries. Kept so a reconcile compares the text the book wrote rather than re-deriving it, and so a code that maps to no ERP warehouse is visible instead of silently absent.';
