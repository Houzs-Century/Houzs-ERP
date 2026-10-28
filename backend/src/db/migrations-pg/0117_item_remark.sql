-- Per-item remark on service-case items (Nick 2026-07-15): editable in
-- the Product Info card and printed in the ITEMS table's
-- "REMARK (IF ANY)" column on both the customer and supplier copies.
ALTER TABLE assr_items ADD COLUMN IF NOT EXISTS remark text;
