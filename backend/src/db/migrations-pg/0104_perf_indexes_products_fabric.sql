-- 0104_perf_indexes_products_fabric.sql — search/list indexes for the SKU,
-- Category and Fabric-Code screens (the mobile "Loading …" bottlenecks).
--
-- Mirrors 0074 (global-search trgm) and extends it to the columns those list
-- endpoints actually filter/search on but that had NO index, so each list/search
-- was a sequential scan as the tables grew:
--   * scm.mfg_products     — 0074 indexed code+name; the SO/SKU search ORs also
--                            over description + barcode (un-indexed → seq scan).
--                            Every list also filters status='ACTIVE' (un-indexed).
--   * scm.fabric_colours   — the picker filters active=true ORDER BY sort_order;
--                            both un-indexed (only company_id had one).
--   * scm.fabric_trackings — the converter searches fabric_code + fabric_description
--                            with leading-wildcard ILIKE; a plain btree can't serve
--                            '%term%', so it needs trigram GIN.
--
-- NOT CONCURRENTLY: the migration runner wraps each file in a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside one (it would error and block every
-- deploy). These tables are small (products ~1.1k, fabric colours ~700), so a
-- plain build takes a millisecond-scale lock. Every statement is idempotent
-- (CREATE EXTENSION / INDEX IF NOT EXISTS) so the auto-apply re-run is a no-op.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── scm.mfg_products (SKU / Category screens) ────────────────────────────────
-- trigram GIN on the two search columns 0074 missed.
CREATE INDEX IF NOT EXISTS trgm_mfg_prod_desc
  ON scm.mfg_products USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_prod_barcode
  ON scm.mfg_products USING gin (barcode gin_trgm_ops);
-- Every product list filters status='ACTIVE' then optionally by category. A
-- partial index on category over just the active rows serves both the
-- active-only and active+category paths without indexing dead rows.
CREATE INDEX IF NOT EXISTS idx_mfg_prod_active_category
  ON scm.mfg_products (category) WHERE status = 'ACTIVE';

-- ── scm.fabric_colours (Fabric-Code picker) ──────────────────────────────────
-- Serves .eq('active', true).order('sort_order') as an index walk (was a seq
-- scan + in-memory sort).
CREATE INDEX IF NOT EXISTS idx_fabric_colours_active_sort
  ON scm.fabric_colours (active, sort_order);

-- ── scm.fabric_trackings (Fabric-Code master / converter search) ─────────────
CREATE INDEX IF NOT EXISTS trgm_fabric_track_code
  ON scm.fabric_trackings USING gin (fabric_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_fabric_track_desc
  ON scm.fabric_trackings USING gin (fabric_description gin_trgm_ops);
