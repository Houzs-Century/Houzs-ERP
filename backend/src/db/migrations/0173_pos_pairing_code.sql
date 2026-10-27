-- D1 / test-tree twin of migrations-pg/20261022T0533_pos_pairing_code.sql.
ALTER TABLE pos_terminals ADD COLUMN pairing_code_hash TEXT;
ALTER TABLE pos_terminals ADD COLUMN pairing_expires_at TEXT;
