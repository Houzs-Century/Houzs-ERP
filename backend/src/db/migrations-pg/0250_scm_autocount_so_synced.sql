-- 0241_scm_autocount_so_synced.sql — track which ERP Sales Orders have been
-- written back into AutoCount, so the /pending endpoint never re-offers a SO the
-- iNiState syncSalesOrder job has already created.
--
-- The ON/OFF switch itself lives in scm.sync_config (key 'so_writeback_enabled',
-- default off / fail-closed) — no schema change needed for the toggle.
--
-- Houzs conventions: schema-qualified to scm.*, no inner BEGIN/COMMIT (pg-migrate
-- owns the transaction), additive + idempotent. RE-CHECK the number at MERGE.
CREATE TABLE IF NOT EXISTS scm.autocount_so_synced (
  doc_no     text PRIMARY KEY,
  ac_docno   text,
  synced_at  timestamptz NOT NULL DEFAULT now()
);
