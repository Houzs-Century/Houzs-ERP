-- 20261111T0300_scm_mrp_list_snapshots.sql
--
-- WHY. The PO / GRN / PI list enrichments and the SO list enrichment ran the
-- company-wide live MRP on every list open (prod, 7 days to 2026-11-10: SO list
-- 5,416 calls p95 3.1 s; PO list 932). Owner 2026-11-10: the lists read a stored
-- result, refreshed every 15 min by the same cron that refreshes
-- scm.mrp_snapshots, and show "MRP as of hh:mm" with a Refresh.
--
-- A SEPARATE table from scm.mrp_snapshots because the lists need the run with
-- UNDATED demand included (includeUndated=true); the MRP page's stored run hides
-- undated rows, so it would drop the Assigned SO of every undated SO line.
--
-- A CACHE, not a book of record: one row per company. When a company has no row,
-- or the row is older than 30 minutes, the lists compute live exactly as before
-- (lib/list-mrp-source.ts), so this migration is inert until the cron first
-- populates it.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.mrp_list_snapshots;
--   Cache only; the lists fall back to live compute, today's behaviour.

SET search_path TO scm, public;

CREATE TABLE IF NOT EXISTS scm.mrp_list_snapshots (
  company_id   bigint      PRIMARY KEY,
  result       jsonb       NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scm.mrp_list_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON TABLE scm.mrp_list_snapshots TO service_role;

COMMENT ON TABLE scm.mrp_list_snapshots IS
  'Stored MRP result (undated demand included) per company for the PO/GRN/PI/SO '
  'list enrichments; refreshed by the */15 cron. Cache only. See lib/list-mrp-source.ts.';
