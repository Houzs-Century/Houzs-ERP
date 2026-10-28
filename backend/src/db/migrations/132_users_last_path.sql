-- D1 / SQLite parity for PG migration 0213 — presence "where" column: the 60s
-- heartbeat stamps the SPA pathname so the who's-online popover can deep-link
-- each teammate's current location. NULL until the user's client sends it.
ALTER TABLE users ADD COLUMN last_path TEXT;
