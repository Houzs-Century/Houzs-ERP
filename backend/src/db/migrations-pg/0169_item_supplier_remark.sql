-- Split per-item remark by audience (Nick 2026-07-21): `remark` stays
-- the CUSTOMER-copy remark; `supplier_remark` prints on the Supplier
-- Service Order. Backfill copies the existing remark so the supplier
-- copy keeps showing exactly what it showed before the split.
ALTER TABLE assr_items ADD COLUMN IF NOT EXISTS supplier_remark text;
UPDATE assr_items SET supplier_remark = remark WHERE remark IS NOT NULL AND supplier_remark IS NULL;
