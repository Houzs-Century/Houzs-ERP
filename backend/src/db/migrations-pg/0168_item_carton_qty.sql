-- Per-item carton quantity — a second, user-selected quantity beside the
-- existing per-set qty (owner 2026-07-21). Shown in the Product Info card
-- and the printed After-Sales Service Request items table.
ALTER TABLE assr_items ADD COLUMN IF NOT EXISTS qty_carton integer DEFAULT 1;
