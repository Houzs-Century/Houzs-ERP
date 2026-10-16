-- 20261014T1445_pos_sync_bookkeeping.sql
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- Houzs POS build, step 6 (the offline sync engine) and the ground for step 7
-- (Sync Status + alerts): a nullable note on a synced bill about its stock
-- deduction (no stock location, or the location went negative), the
-- heartbeat log a terminal sends every few minutes, and the alert ledger the
-- ERP emails the office from. One nullable column and two new tables; no
-- existing row is touched.
--
-- REVERSAL: DROP TABLE pos_alerts, pos_heartbeats; ALTER TABLE pos_sales DROP
--   COLUMN stock_warning; ALTER TABLE pos_terminals DROP COLUMN db_empty_at,
--   DROP COLUMN last_known_pending_count, DROP COLUMN last_known_pending_sen.
--   GRANTS: none.
-- Verified against: the migrations-pg tree (pos_sales / pos_terminals from
--   20261014T1147 and 20261014T1304).

SET search_path = public;

ALTER TABLE pos_sales ADD COLUMN IF NOT EXISTS stock_warning TEXT;

-- The last heartbeat that still reported pending sales, so an empty device
-- reconnecting later is recognised as DATA LOST (layout E7).
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS last_known_pending_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS last_known_pending_sen BIGINT NOT NULL DEFAULT 0;
ALTER TABLE pos_terminals ADD COLUMN IF NOT EXISTS db_empty_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS pos_heartbeats (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT NOT NULL,
  terminal_id   BIGINT NOT NULL REFERENCES pos_terminals (id) ON DELETE CASCADE,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_pos_heartbeats_terminal_at ON pos_heartbeats (terminal_id, at DESC);

CREATE TABLE IF NOT EXISTS pos_alerts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('PENDING_STALE', 'EVENT_ENDED_PENDING', 'DATA_LOST', 'STOCK_NEGATIVE')),
  terminal_id     BIGINT REFERENCES pos_terminals (id) ON DELETE CASCADE,
  project_id      BIGINT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  email_sent_at   TIMESTAMPTZ,
  last_resent_at  TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pos_alerts_open ON pos_alerts (company_id, resolved_at) WHERE resolved_at IS NULL;
