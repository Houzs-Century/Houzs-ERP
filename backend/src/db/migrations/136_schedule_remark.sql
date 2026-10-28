-- D1 / SQLite parity for PG migration 0218 — the Schedule Reference remark
-- (owner 2026-07-23): solo events have no handbook screenshot, so logistics
-- types the setup/dismantle times as free text in the same box.
ALTER TABLE projects ADD COLUMN schedule_remark TEXT;
