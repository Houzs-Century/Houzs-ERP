-- 035_stock_items_cache.sql
-- Local cache of AutoCount /StockItem/getSingle responses. Mirrors
-- the Creditors pattern (migration 033): one row per item_code with
-- the full upstream payload in `raw` plus a few extracted columns
-- that we query directly (main_supplier for creditor resolution,
-- is_active, cost/price for future PO-ish reports).
--
-- Populated lazily: a case's first reference to an item_code triggers
-- getStockItemCached() which pulls and upserts. A nightly refresh
-- (or the /api/stockitems/refresh endpoint) walks every item_code
-- referenced by non-archived cases.

CREATE TABLE IF NOT EXISTS stock_items (
  item_code        TEXT PRIMARY KEY,
  auto_key         TEXT,
  doc_key          TEXT,
  description      TEXT,
  desc2            TEXT,
  item_group       TEXT,
  item_type        TEXT,
  item_brand       TEXT,
  item_class       TEXT,
  item_category    TEXT,
  base_uom         TEXT,
  sales_uom        TEXT,
  purchase_uom     TEXT,
  main_supplier    TEXT,   -- creditor_code of the default/primary supplier
  is_active        INTEGER DEFAULT 1,
  is_sales_item    INTEGER,
  is_purchase_item INTEGER,
  lead_time        INTEGER,
  cost             REAL,
  price            REAL,
  tax_code         TEXT,
  purchase_tax_code TEXT,
  barcode2         TEXT,   -- UDF_Barcode2
  cost_code        TEXT,   -- UDF_CostCode
  last_modified    TEXT,
  raw              TEXT,   -- full JSON payload for forward-compat
  fetched_at       TEXT DEFAULT (datetime('now')),
  created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Lookups by main_supplier for the "By Creditor" tab + cost reports.
CREATE INDEX IF NOT EXISTS idx_stock_items_main_supplier ON stock_items(main_supplier);
CREATE INDEX IF NOT EXISTS idx_stock_items_item_group   ON stock_items(item_group);
