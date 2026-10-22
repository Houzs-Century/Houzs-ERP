-- 20261022T0533_pos_pairing_code.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Houzs POS: a device is now paired FROM the ERP (POS Admin > Terminals >
-- Pair device hands out a one-time code) instead of an ERP sign-in on the
-- device. The terminal row keeps the code's hash and its expiry until the
-- device redeems it. Two nullable columns; no row is touched.
--
-- REVERSAL: ALTER TABLE pos_terminals DROP COLUMN pairing_code_hash,
--           DROP COLUMN pairing_expires_at. GRANTS: none.
-- Verified against: the migrations-pg tree (pos_terminals from 20261014T1304).

SET search_path = public;

ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS pairing_code_hash TEXT;
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS pairing_expires_at TIMESTAMPTZ;
