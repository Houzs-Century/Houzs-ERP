-- 029_po_amounts.sql
-- Adds cost amount columns to purchase_orders so the P&L module can
-- include PO spend. AutoCount middleware may or may not return these
-- fields — the sync tries to populate them but leaves NULL when the
-- upstream payload is missing them. The UI then lets a user edit the
-- amount manually (useful when AutoCount is licensed to a role that
-- doesn't show price to everyone).
--
-- Money fields:
--   unit_price   — per-unit buy cost
--   amount       — line total (preferred; unit_price × remaining_qty as
--                  a derivation fallback in queries if only one side
--                  was provided by the upstream)
--   amount_source — 'sync' (from AutoCount payload) or 'manual' (typed
--                  by a user). Makes the P&L breakdown transparent.

ALTER TABLE purchase_orders ADD COLUMN unit_price REAL;
ALTER TABLE purchase_orders ADD COLUMN amount REAL;
ALTER TABLE purchase_orders ADD COLUMN amount_source TEXT;
ALTER TABLE purchase_orders ADD COLUMN amount_updated_at TEXT;
ALTER TABLE purchase_orders ADD COLUMN amount_updated_by INTEGER;

-- Helpful for the aggregation query — filter to rows that have a
-- usable amount in one hop.
CREATE INDEX IF NOT EXISTS idx_po_amount ON purchase_orders(doc_date, amount);
