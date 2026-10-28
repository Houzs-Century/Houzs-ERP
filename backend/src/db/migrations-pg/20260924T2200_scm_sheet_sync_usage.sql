-- 20260924T2200_scm_sheet_sync_usage.sql
--
-- Per-endpoint, per-day usage counters for /api/delivery-sheet — the HC
-- Delivery sheet's own traffic against the ERP.
--
-- WHY THIS TABLE EXISTS. Owner 2026-09-24, auditing the sheet's Apps Script:
-- "每个 gs 的来源用处 / 调用次数 / 监控调用次数、数据量", so that a script
-- unused for a month can be isolated and one unused for three months can be
-- deleted on evidence rather than on memory. Nothing in the ERP could answer
-- "how often does the sheet call this endpoint, and how much does it carry":
--
--   · the router writes no log of its own;
--   · requestLog's Analytics Engine data point is INERT here — Houzs has no
--     ERP_METRICS binding (routes/systemHealth.ts says so in its header), and
--     even where AE is bound it expires in ~90 days and has no row-count
--     dimension, which is exactly the horizon the owner's 3-month rule needs;
--   · `wrangler tail` only shows the request that is happening right now.
--
-- The only surviving evidence was the sheet's own "Track Record (Logs)" tab,
-- which counts SCRIPT RUNS, not endpoint calls — one `scheduledErpSync` run is
-- three to four HTTP requests, and a script that stops logging (HC_Dashboard
-- did, on 2026-07-30) silently disappears from it while still running. This
-- table is the ERP's own count, and it does not expire.
--
-- SHAPE. One row per (endpoint, Malaysian day). A counter, not a log: the
-- sheet calls ~300-400 times a day, and a per-request row would be ~140k rows
-- a year to answer a question that is always asked per day. ~12 endpoints x
-- 365 days = ~4.4k rows/year, and the whole retention question goes away.
--
--   endpoint  'GET /api/delivery-sheet/so-since' — the route PATTERN and the
--             method, never the URL: `?since=` carries a timestamp and
--             /feed-by-docnos carries order numbers.
--   day       the MALAYSIAN calendar day. The daily 07:00 MYT triggers are
--             23:00 UTC the day before, so a UTC day would split them.
--   calls     requests that PASSED the shared-secret check. A wrong key is
--             deliberately not counted: it must keep touching no database at
--             all (rate limit + 401), or this counter becomes an
--             unauthenticated write amplifier.
--   rows_out  records the response carried (the feed's `count`), so "数据量"
--             is answerable per endpoint, not just "was it called".
--   errors    responses >= 400 among those authenticated calls.
--
-- REVERSAL: DROP TABLE IF EXISTS scm.sheet_sync_usage;

CREATE TABLE IF NOT EXISTS scm.sheet_sync_usage (
  endpoint  text        NOT NULL,
  day       date        NOT NULL,
  calls     bigint      NOT NULL DEFAULT 0,
  rows_out  bigint      NOT NULL DEFAULT 0,
  errors    bigint      NOT NULL DEFAULT 0,
  first_at  timestamptz NOT NULL DEFAULT now(),
  last_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint, day)
);

-- The report reads a date WINDOW across every endpoint ("last 30 days", "did
-- anything call this in 3 months"), which the (endpoint, day) primary key
-- cannot serve leading-column-first.
CREATE INDEX IF NOT EXISTS sheet_sync_usage_day_idx ON scm.sheet_sync_usage (day);

COMMENT ON TABLE scm.sheet_sync_usage IS
  'Per-endpoint daily call/row counters for /api/delivery-sheet (the HC Delivery sheet''s Apps Script). Written by the router''s usage middleware; read by backend/scripts/check-sheet-sync-usage.mjs.';

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The Worker writes it through Hyperdrive as the owner role; PostgREST's
-- service role only ever needs to READ the counters.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT ON scm.sheet_sync_usage TO service_role;
  END IF;
END
$grant$;
