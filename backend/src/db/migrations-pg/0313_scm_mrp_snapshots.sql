-- 0313_scm_mrp_snapshots — stored MRP planning result per company.
--
-- WHY. Opening the MRP page ran the whole computeMrp engine live on every load
-- (~4s). Owner decision 2026-08-19: MRP becomes a stored "planning run" (option
-- B — the industry norm; SAP / Oracle / NetSuite run MRP as a scheduled/on-demand
-- planning run and the screen reads the stored result), refreshed on a schedule
-- (~15 min) plus a manual "Regenerate" button, with the page showing "as of
-- <computed_at>".
--
-- This table is a CACHE, not a book of record: one row per company holding the
-- full computeMrp result (catFilter=null, whFilter=null, includeUndated=true — the
-- filters are display-only, so one full result serves every filtered view). The
-- MRP GET falls back to live computeMrp when a company has no row yet, so this
-- migration is inert until the refresh job / Regenerate first populates it.
--
-- REVERSAL: DROP TABLE IF EXISTS scm.mrp_snapshots;  -- cache only, no data of
--   record; the MRP page returns to live compute-on-load, exactly today's behaviour.
-- Verified against: local pg-migrate dry run (fill the deploy line on merge).

CREATE TABLE IF NOT EXISTS scm.mrp_snapshots (
  company_id   bigint      PRIMARY KEY,
  result       jsonb       NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
