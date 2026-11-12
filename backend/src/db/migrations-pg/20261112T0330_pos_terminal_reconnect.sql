-- 20261112T0330_pos_terminal_reconnect.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Houzs POS: a device that lost its terminal (another device was set up on
-- it) can ask to have it back, and a supervisor approves from another device
-- or from POS Admin; nobody at the booth types a code. The terminal row keeps
-- the hash of the token it held just before the swap (so only that device can
-- ask), and the open request with its approval. Five nullable columns; no row
-- is touched, and a terminal without them behaves exactly as before.
--
-- REVERSAL: ALTER TABLE pos_terminals DROP COLUMN prev_token_hash,
--           DROP COLUMN reconnect_requested_at, DROP COLUMN reconnect_device_name,
--           DROP COLUMN reconnect_approved_at, DROP COLUMN reconnect_approved_by.
--           GRANTS: none.
-- Verified against: the migrations-pg tree (pos_terminals from 20261014T1304).

SET search_path = public;

ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS prev_token_hash TEXT;
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS reconnect_requested_at TIMESTAMPTZ;
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS reconnect_device_name TEXT;
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS reconnect_approved_at TIMESTAMPTZ;
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS reconnect_approved_by TEXT;
