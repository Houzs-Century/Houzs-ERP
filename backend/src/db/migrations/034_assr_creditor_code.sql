-- 034_assr_creditor_code.sql
-- Add a `creditor_code` column to ASSR cases so each case can be
-- linked to the AutoCount creditor (procurement supplier) who sold
-- the item being serviced. The value is resolved from the item's
-- StockItem.MainSupplier via the cached /StockItem/getSingle lookup
-- (see runStockItemsRefresh).
--
-- We intentionally do NOT drop the existing supplier_id / supplier /
-- supplier_rating*/supplier_job_status columns here — Phase 5 handles
-- that once the UI has flipped and nothing reads them.

ALTER TABLE assr_cases ADD COLUMN creditor_code TEXT;

-- Not a FK (creditors.creditor_code is TEXT PK; SQLite FK support in
-- D1 is loose). An index is enough for the planned joins + filters.
CREATE INDEX IF NOT EXISTS idx_assr_creditor_code ON assr_cases(creditor_code);
