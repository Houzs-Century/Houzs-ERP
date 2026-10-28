-- ============================================================================
-- 2990 → Houzs LIVE SO mirror — RECONCILE / SELF-HEAL (on 2990 DB)
-- Apply AFTER 02. The backstop that makes "一个不漏" provable and self-healing:
-- any SO that has no successfully-delivered ('done') outbox row gets a fresh
-- pending row, so the next drain re-sends it. Covers the (near-impossible) case
-- of a trigger-missed row or a permanently-failed delivery.
-- ============================================================================

CREATE OR REPLACE FUNCTION reconcile_so_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE n INT;
BEGIN
  INSERT INTO sync_outbox(entity, entity_key, op, status)
  SELECT 'sales_order', so.doc_no, 'RECONCILE', 'pending'
    FROM mfg_sales_orders so
   WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox o
            WHERE o.entity_key = so.doc_no AND o.status = 'done')
     AND NOT EXISTS (
           SELECT 1 FROM sync_outbox o                 -- don't pile up duplicates
            WHERE o.entity_key = so.doc_no AND o.status IN ('pending','sent'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;  -- rows re-queued; steady state should be 0
END $fn$;

-- Hourly self-heal. (The cross-database count sentinel — 2990 SO count vs Houzs
-- company_id=2 SO count, which ALARMS on drift — runs as a GitHub Action that
-- holds both DB credentials; see 04_sentinel notes. This function only self-heals
-- the 2990 side's own queue.)
SELECT cron.schedule('so_outbox_reconcile', '0 * * * *', 'SELECT reconcile_so_outbox();');

-- Optional housekeeping: trim delivered rows older than 30 days so the outbox
-- stays small (history already lives in both DBs).
SELECT cron.schedule('so_outbox_vacuum', '30 3 * * *',
  $$DELETE FROM sync_outbox WHERE status='done' AND delivered_at < now() - interval '30 days'$$);
