-- D1 / test-tree twin of migrations-pg/20261112T0330_pos_terminal_reconnect.sql.
ALTER TABLE pos_terminals ADD COLUMN prev_token_hash TEXT;
ALTER TABLE pos_terminals ADD COLUMN reconnect_requested_at TEXT;
ALTER TABLE pos_terminals ADD COLUMN reconnect_device_name TEXT;
ALTER TABLE pos_terminals ADD COLUMN reconnect_approved_at TEXT;
ALTER TABLE pos_terminals ADD COLUMN reconnect_approved_by TEXT;
