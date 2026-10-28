-- D1 test-mirror of migrations-pg/0063_assr_supplier_notes.sql.
-- Two notes that travel with the item between Houzs and supplier
-- (send-out slip we write; service record supplier writes back).
ALTER TABLE assr_cases ADD COLUMN goods_returned_note TEXT;
ALTER TABLE assr_cases ADD COLUMN supplier_service_note TEXT;
