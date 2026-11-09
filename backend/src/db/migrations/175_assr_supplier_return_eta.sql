-- D1 test mirror of migrations-pg/20261109T1200_assr_supplier_return_eta.sql.
ALTER TABLE assr_supplier_returns ADD COLUMN expected_return_at TEXT;
