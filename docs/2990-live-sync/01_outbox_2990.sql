-- ============================================================================
-- 2990 → Houzs LIVE SO mirror — OUTBOX (zero-loss capture)
-- Applies to the 2990 SOURCE database (packages/db/migrations on wenwei4046/2990s).
-- ============================================================================
-- WHY a DB trigger (not app code): the 2990 backend uses Supabase PostgREST,
-- which has NO cross-table transaction. Capturing the outbox row in APP code
-- (after the SO insert) would lose rows if the process dies between the two
-- writes. A trigger fires in the SAME transaction as the SO commit, so every
-- committed SO is guaranteed an outbox row — true 一个不漏.
--
-- POS SAFETY: the trigger function swallows its own errors. An outbox failure
-- must NEVER roll back / block a 門店 sale. In the (near-impossible) event a row
-- is missed, the reconciliation sweep (04_reconcile) backfills it. So:
--   primary zero-loss = trigger (same-tx)   +   backstop = reconciliation.
--
-- Idempotent / re-runnable: IF NOT EXISTS + CREATE OR REPLACE + DROP TRIGGER IF.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_outbox (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity       TEXT        NOT NULL,           -- 'sales_order'
  entity_key   TEXT        NOT NULL,           -- doc_no of the SO
  op           TEXT        NOT NULL,           -- INSERT | UPDATE | DELETE (+ ':table' for child edits)
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,                    -- NULL until Houzs acks the mirror
  attempts     INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT
);

-- Fast scan of the work queue: only undelivered rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
  ON sync_outbox (enqueued_at) WHERE delivered_at IS NULL;

-- ---- header trigger: fires on any change to the SO row itself ---------------
CREATE OR REPLACE FUNCTION enqueue_so_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  BEGIN
    INSERT INTO sync_outbox(entity, entity_key, op)
    VALUES ('sales_order', COALESCE(NEW.doc_no, OLD.doc_no), TG_OP);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never block the sale; reconciliation backfills a missed row
  END;
  RETURN NULL;  -- AFTER trigger: return value ignored
END $fn$;

DROP TRIGGER IF EXISTS trg_so_outbox ON mfg_sales_orders;
CREATE TRIGGER trg_so_outbox
  AFTER INSERT OR UPDATE OR DELETE ON mfg_sales_orders
  FOR EACH ROW EXECUTE FUNCTION enqueue_so_outbox();

-- ---- child trigger: item/payment edits must also re-forward the parent SO ---
-- (the 2990 backend does not always bump the header updated_at when only a line
--  or payment changes, so we capture the parent doc_no from the child row.)
CREATE OR REPLACE FUNCTION enqueue_so_outbox_child() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  keycol TEXT := TG_ARGV[0];
  dn     TEXT;
BEGIN
  BEGIN
    dn := COALESCE(to_jsonb(NEW) ->> keycol, to_jsonb(OLD) ->> keycol);
    IF dn IS NOT NULL THEN
      INSERT INTO sync_outbox(entity, entity_key, op)
      VALUES ('sales_order', dn, TG_OP || ':' || TG_TABLE_NAME);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never block the write
  END;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_so_items_outbox ON mfg_sales_order_items;
CREATE TRIGGER trg_so_items_outbox
  AFTER INSERT OR UPDATE OR DELETE ON mfg_sales_order_items
  FOR EACH ROW EXECUTE FUNCTION enqueue_so_outbox_child('doc_no');

DROP TRIGGER IF EXISTS trg_so_payments_outbox ON mfg_sales_order_payments;
CREATE TRIGGER trg_so_payments_outbox
  AFTER INSERT OR UPDATE OR DELETE ON mfg_sales_order_payments
  FOR EACH ROW EXECUTE FUNCTION enqueue_so_outbox_child('so_doc_no');

-- Backfill: enqueue every existing SO once so the first drain mirrors history.
-- (idempotent: the worker upserts by doc_no on the Houzs side.)
INSERT INTO sync_outbox(entity, entity_key, op)
SELECT 'sales_order', doc_no, 'BACKFILL' FROM mfg_sales_orders;
