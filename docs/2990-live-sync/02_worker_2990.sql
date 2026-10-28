-- ============================================================================
-- 2990 → Houzs LIVE SO mirror — DRAIN WORKER (pg_net + pg_cron, on 2990 DB)
-- Requires extensions: pg_net, pg_cron  (Supabase → Database → Extensions).
-- Apply AFTER 01_outbox_2990.sql.
-- ============================================================================

-- delivery-tracking columns on the outbox
ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'pending'; -- pending|sent|done
ALTER TABLE sync_outbox ADD COLUMN IF NOT EXISTS http_request_id BIGINT;

-- Receiver URL + shared secret. Kept in a table (not hardcoded) so staging/prod
-- differ by data only. Set these two rows out-of-band (NOT committed):
--   INSERT INTO sync_config VALUES ('houzs_url','https://<houzs>/api/sync/so-mirror')
--     ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v;
--   INSERT INTO sync_config VALUES ('sync_secret','<same as Houzs SYNC_SECRET>')
--     ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v;
CREATE TABLE IF NOT EXISTS sync_config (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- ---- DRAIN: build each pending SO's payload, fire async POST, mark 'sent' ----
CREATE OR REPLACE FUNCTION drain_so_outbox(batch INT DEFAULT 50) RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE
  v_url TEXT; v_secret TEXT; r RECORD; payload JSONB; req BIGINT; n INT := 0;
BEGIN
  SELECT v INTO v_url    FROM sync_config WHERE k = 'houzs_url';
  SELECT v INTO v_secret FROM sync_config WHERE k = 'sync_secret';
  IF v_url IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT DISTINCT entity_key
      FROM sync_outbox
     WHERE status = 'pending' AND entity = 'sales_order'
     ORDER BY entity_key
     LIMIT batch
  LOOP
    IF EXISTS (SELECT 1 FROM mfg_sales_orders WHERE doc_no = r.entity_key) THEN
      SELECT jsonb_build_object(
               'docNo',    so.doc_no,
               'header',   to_jsonb(so),
               'items',    COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM mfg_sales_order_items i    WHERE i.doc_no    = so.doc_no), '[]'::jsonb),
               'payments', COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM mfg_sales_order_payments p WHERE p.so_doc_no = so.doc_no), '[]'::jsonb))
        INTO payload
        FROM mfg_sales_orders so WHERE so.doc_no = r.entity_key;
    ELSE
      payload := jsonb_build_object('docNo', r.entity_key, 'deleted', true);
    END IF;

    req := net.http_post(
      url                    := v_url,
      body                   := payload,
      headers                := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
      timeout_milliseconds   := 8000);

    UPDATE sync_outbox SET status = 'sent', http_request_id = req, attempts = attempts + 1
     WHERE entity_key = r.entity_key AND status = 'pending';
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;

-- ---- CONFIRM: 2xx => done; anything else => back to pending (retry) ----------
CREATE OR REPLACE FUNCTION confirm_so_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT o.id, resp.status_code
      FROM sync_outbox o
      JOIN net._http_response resp ON resp.id = o.http_request_id
     WHERE o.status = 'sent'
  LOOP
    IF r.status_code BETWEEN 200 AND 299 THEN
      UPDATE sync_outbox SET status='done', delivered_at = now(), last_error = NULL WHERE id = r.id;
    ELSE
      UPDATE sync_outbox SET status='pending', last_error = 'http '||COALESCE(r.status_code::text,'timeout') WHERE id = r.id;
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;

-- ---- schedule: drain + confirm on a tight loop (真 live) ---------------------
-- Supabase pg_cron supports sub-minute intervals ('10 seconds'). If your pg_cron
-- is minute-only, use '* * * * *' (60s) instead — still far better than a pull.
SELECT cron.schedule('so_outbox_drain',   '10 seconds', 'SELECT drain_so_outbox();');
SELECT cron.schedule('so_outbox_confirm', '15 seconds', 'SELECT confirm_so_outbox();');
