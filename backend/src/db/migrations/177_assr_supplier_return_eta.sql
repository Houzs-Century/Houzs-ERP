-- D1 test mirror of migrations-pg/20261110T1300_assr_supplier_return_eta.sql.
ALTER TABLE assr_supplier_returns ADD COLUMN expected_return_at TEXT;
