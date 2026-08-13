-- AutoCount FULL-snapshot staging tables — the denominator the migration
-- reconciliation has never had.
--
-- WHY THIS EXISTS. `sales_orders` is not a copy of AutoCount, it is a
-- FILTERED copy, and the filter is invisible from the data: runPull() drops
-- every order for which routeRegion() returns null — i.e. any SalesLocation
-- outside {KL, PG, HQ, SBH, SRW} and any non-Singapore address. On 2026-08-12
-- the mirror held 3,208 rows while AutoCount had issued SO numbers up to
-- SO-013214. So "is the migration clean yet?" was unanswerable by
-- construction: 2,213 ERP orders carry a linked_ac_docno the mirror has never
-- heard of, and nobody could tell a genuine gap from a filtered-out row.
--
-- These tables are deliberately NOT the mirror:
--   * every row from /getAll is stored, filter or no filter;
--   * `region_route` records what routeRegion() WOULD have returned, so
--     "the live mirror dropped this one, and here is why" is a WHERE clause
--     rather than an archaeology exercise;
--   * `raw` keeps the untouched payload, so a question nobody thought to ask
--     today does not need another 70 MB round trip tomorrow.
--
-- Nothing reads these tables in the request path. They exist to be diffed
-- against scm.mfg_sales_orders / scm.purchase_orders, and they are safe to
-- truncate and rebuild at any time.

CREATE TABLE IF NOT EXISTS ac_snapshot_runs (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status       TEXT NOT NULL,
  fetched      INTEGER NOT NULL DEFAULT 0,
  stored       INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  message      TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE INDEX IF NOT EXISTS ac_snapshot_runs_kind_started_idx
  ON ac_snapshot_runs (kind, started_at DESC);

CREATE TABLE IF NOT EXISTS ac_snapshot_sales_orders (
  doc_no         TEXT PRIMARY KEY,
  doc_date       TEXT,
  ref            TEXT,
  branding       TEXT,
  debtor_name    TEXT,
  sales_location TEXT,
  sales_agent    TEXT,
  venue          TEXT,
  local_total    DOUBLE PRECISION,
  balance        DOUBLE PRECISION,
  remark2        TEXT,
  transfer_to    TEXT,
  po_doc_no      TEXT,
  last_modified  TEXT,
  -- What routeRegion() would return for this row. NULL = the live
  -- `sales_orders` mirror silently skips it.
  region_route   TEXT,
  raw            TEXT,
  -- Every row written by one run carries that run's timestamp, so
  -- `snapshot_at` joins a row back to its ac_snapshot_runs entry and also
  -- exposes leftovers: a row whose snapshot_at is older than the newest run
  -- is a document AutoCount no longer returns.
  snapshot_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ac_snapshot_so_region_idx
  ON ac_snapshot_sales_orders (region_route);
CREATE INDEX IF NOT EXISTS ac_snapshot_so_doc_date_idx
  ON ac_snapshot_sales_orders (doc_date);

CREATE TABLE IF NOT EXISTS ac_snapshot_purchase_orders (
  doc_no            TEXT PRIMARY KEY,
  doc_date          TEXT,
  ref               TEXT,
  so_doc_no         TEXT,
  creditor_code     TEXT,
  creditor_name     TEXT,
  purchase_location TEXT,
  doc_status        TEXT,
  cancelled         INTEGER NOT NULL DEFAULT 0,
  local_ex_tax      DOUBLE PRECISION,
  local_net_total   DOUBLE PRECISION,
  final_total       DOUBLE PRECISION,
  currency_code     TEXT,
  last_modified     TEXT,
  raw               TEXT,
  snapshot_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ac_snapshot_po_doc_date_idx
  ON ac_snapshot_purchase_orders (doc_date);
CREATE INDEX IF NOT EXISTS ac_snapshot_po_cancelled_idx
  ON ac_snapshot_purchase_orders (cancelled);
