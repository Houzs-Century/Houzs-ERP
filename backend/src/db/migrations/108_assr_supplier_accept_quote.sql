-- D1 test-mirror of migrations-pg/0065_assr_supplier_accept_quote.sql.
-- Supplier portal Accept job + Submit quote fields.
ALTER TABLE assr_cases ADD COLUMN supplier_accepted_at TEXT;
ALTER TABLE assr_cases ADD COLUMN supplier_quote_labour REAL;
ALTER TABLE assr_cases ADD COLUMN supplier_quote_materials REAL;
ALTER TABLE assr_cases ADD COLUMN supplier_quote_at TEXT;
