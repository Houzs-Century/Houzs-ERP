-- D1 test mirror of migrations-pg/0169_item_supplier_remark.sql.
ALTER TABLE assr_items ADD COLUMN supplier_remark TEXT;
UPDATE assr_items SET supplier_remark = remark WHERE remark IS NOT NULL AND supplier_remark IS NULL;
