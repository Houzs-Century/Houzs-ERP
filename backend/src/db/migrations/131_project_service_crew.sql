-- D1 / SQLite parity for PG migration 0169 — the Service / Exchange logistics
-- trip (owner 2026-07-22). Same JSON shape as setup_crew / dismantle_crew plus
-- a `remark` ("what service/exchange"); written by the desktop crew editor.
ALTER TABLE projects ADD COLUMN service_crew TEXT;
