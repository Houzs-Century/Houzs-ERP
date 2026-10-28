-- ============================================================================
-- 2990 -> Houzs LIVE SO AMENDMENT mirror — OUTBOX + DRAIN + CONFIRM + RECONCILE
-- Applies to the 2990 SOURCE database. Paste into the Supabase SQL editor.
-- Apply AFTER 01/02/03 (this reuses their sync_outbox + sync_config tables).
--
-- WHAT THIS IS FOR: an SO Amendment raised in 2990 must appear in Houzs, so the
-- owner sees the pending request without opening the POS. ONE-WAY only. Houzs
-- cannot drive a mirrored amendment (its five mutation gates refuse any SO whose
-- doc_no starts `2990-`). Approving still happens in 2990.
--
-- ============================================================================
-- THE ONE RULE THIS FILE EXISTS TO RESPECT: DO NOT TOUCH THE WORKING SO MIRROR.
-- ============================================================================
-- drain_so_outbox(), enqueue_so_outbox(), enqueue_so_outbox_child(), their three
-- triggers and their two cron jobs are FROZEN. Nothing below alters, replaces or
-- drops any of them. This file only ADDS: two trigger functions, two triggers,
-- three functions and three cron jobs, all carrying entity = 'so_amendment'.
-- The SO mirror keeps running untouched alongside. If this whole file were
-- reverted, the SO mirror would not notice.
--
-- ---------------------------------------------------------------------------
-- WHY entity_key IS THE AMENDMENT uuid AND NOT THE SO doc_no — LOAD-BEARING
-- ---------------------------------------------------------------------------
-- We share the sync_outbox TABLE with the SO path, and two of the SO path's
-- functions read that table WITHOUT filtering on `entity`:
--
--   * reconcile_so_outbox() (03) re-queues any SO with no `done` row, matching
--     ONLY on `o.entity_key = so.doc_no`. Had we keyed amendments by so_doc_no,
--     a delivered AMENDMENT row for 'SO-2607-006' would read as proof that the
--     SALES ORDER 'SO-2607-006' had been delivered — silently suppressing the
--     SO's self-heal. The SO mirror would stop reconciling and no one would see
--     it. Keying on the amendment uuid makes that collision impossible: a uuid
--     is never equal to a doc_no.
--   * confirm_so_outbox() (02) confirms every row in status 'sent' regardless of
--     entity, so it WILL also confirm the rows this file enqueues. That is
--     harmless — it reads the same net._http_response row and applies the same
--     2xx/else branch as confirm_amendment_outbox() below, so both compute the
--     same result and the row lock serialises them. Documented, not relied on:
--     our own confirm is entity-filtered and correct on its own.
--
-- Every function BELOW filters on entity. The asymmetry is deliberate: we accept
-- the frozen path's looseness rather than "fix" it and risk the one link that
-- works.
--
-- ---------------------------------------------------------------------------
-- POS SAFETY: same contract as 01. Both trigger functions swallow their own
-- errors. An outbox failure must NEVER roll back or block a 門店 sale, and an
-- amendment is raised on a live retail SO. Missed rows are backfilled by
-- reconcile_amendment_outbox() below.
--
-- Idempotent / re-runnable: IF NOT EXISTS + CREATE OR REPLACE + DROP TRIGGER IF
-- + cron.unschedule guards. Safe to paste twice.
-- ============================================================================


-- ---- 1. TRIGGERS: capture every amendment change, in the same transaction ----
-- Header. entity_key = the amendment's uuid (see the note above).
CREATE OR REPLACE FUNCTION enqueue_amendment_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  BEGIN
    INSERT INTO sync_outbox(entity, entity_key, op)
    VALUES ('so_amendment', COALESCE(NEW.id, OLD.id)::text, TG_OP);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never block the write; reconciliation backfills a missed row
  END;
  RETURN NULL;  -- AFTER trigger: return value ignored
END $fn$;

DROP TRIGGER IF EXISTS trg_amendment_outbox ON so_amendments;
CREATE TRIGGER trg_amendment_outbox
  AFTER INSERT OR UPDATE OR DELETE ON so_amendments
  FOR EACH ROW EXECUTE FUNCTION enqueue_amendment_outbox();

-- Lines. A line edit must re-forward the PARENT amendment, because the receiver
-- replaces the whole line set per amendment (delete-then-insert), exactly as the
-- SO mirror replaces items/payments per SO.
CREATE OR REPLACE FUNCTION enqueue_amendment_outbox_child() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  keycol TEXT := TG_ARGV[0];
  ak     TEXT;
BEGIN
  BEGIN
    ak := COALESCE(to_jsonb(NEW) ->> keycol, to_jsonb(OLD) ->> keycol);
    IF ak IS NOT NULL THEN
      INSERT INTO sync_outbox(entity, entity_key, op)
      VALUES ('so_amendment', ak, TG_OP || ':' || TG_TABLE_NAME);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never block the write
  END;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_amendment_lines_outbox ON so_amendment_lines;
CREATE TRIGGER trg_amendment_lines_outbox
  AFTER INSERT OR UPDATE OR DELETE ON so_amendment_lines
  FOR EACH ROW EXECUTE FUNCTION enqueue_amendment_outbox_child('amendment_id');


-- ---- 2. DRAIN: build each pending amendment's payload, POST it, mark 'sent' --
-- A SECOND, PARALLEL drain. drain_so_outbox() is untouched and unaware of this.
--
-- Config keys read (set out-of-band, NOT committed — see step 5 below):
--   houzs_amendment_url — https://<houzs>/api/sync/amendment-mirror
--   sync_secret         — shared with the SO mirror (same Houzs Worker, same
--                         SYNC_SECRET); reused deliberately, not duplicated.
--   enabled_entities    — CSV kill switch (D8). MISSING/absent => this drain
--                         no-ops, so the feature ships DARK and is turned on by
--                         adding a row, with no deploy. Removing 'so_amendment'
--                         from the CSV stops the amendment mirror INSTANTLY and
--                         leaves the SO mirror running.
CREATE OR REPLACE FUNCTION drain_amendment_outbox(batch INT DEFAULT 50) RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE
  v_url TEXT; v_secret TEXT; v_entities TEXT; r RECORD; payload JSONB; req BIGINT; n INT := 0;
BEGIN
  SELECT v INTO v_entities FROM sync_config WHERE k = 'enabled_entities';
  IF NOT ('so_amendment' = ANY(string_to_array(COALESCE(v_entities, ''), ','))) THEN
    RETURN 0;  -- kill switch / not yet enabled
  END IF;

  SELECT v INTO v_url    FROM sync_config WHERE k = 'houzs_amendment_url';
  SELECT v INTO v_secret FROM sync_config WHERE k = 'sync_secret';
  IF v_url IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT DISTINCT entity_key
      FROM sync_outbox
     WHERE status = 'pending' AND entity = 'so_amendment'
     ORDER BY entity_key
     LIMIT batch
  LOOP
    IF EXISTS (SELECT 1 FROM so_amendments WHERE id = r.entity_key::uuid) THEN
      SELECT jsonb_build_object(
               'amendmentId', a.id,
               'header',      to_jsonb(a),
               'lines',       COALESCE((SELECT jsonb_agg(to_jsonb(l))
                                          FROM so_amendment_lines l
                                         WHERE l.amendment_id = a.id), '[]'::jsonb))
        INTO payload
        FROM so_amendments a WHERE a.id = r.entity_key::uuid;
    ELSE
      payload := jsonb_build_object('amendmentId', r.entity_key, 'deleted', true);
    END IF;

    req := net.http_post(
      url                  := v_url,
      body                 := payload,
      headers              := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
      timeout_milliseconds := 8000);

    -- `AND entity = 'so_amendment'`: never flip an SO row's status/http_request_id.
    -- The uuid key already makes a collision impossible; this makes it structural.
    UPDATE sync_outbox SET status = 'sent', http_request_id = req, attempts = attempts + 1
     WHERE entity_key = r.entity_key AND entity = 'so_amendment' AND status = 'pending';
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;


-- ---- 3. CONFIRM: 2xx => done; anything else => back to pending (retry) -------
-- Entity-filtered mirror of confirm_so_outbox(). See the header note: the SO
-- confirm is NOT entity-filtered and will also process these rows, identically.
CREATE OR REPLACE FUNCTION confirm_amendment_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT o.id, resp.status_code
      FROM sync_outbox o
      JOIN net._http_response resp ON resp.id = o.http_request_id
     WHERE o.status = 'sent' AND o.entity = 'so_amendment'
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


-- ---- 4. RECONCILE / SELF-HEAL ------------------------------------------------
-- Any amendment with no successfully-delivered row gets a fresh pending row.
-- Backstop for a trigger-missed row (the triggers swallow errors) or a
-- permanently-failed delivery. Entity-filtered on BOTH sub-queries — without
-- that, an SO's 'done' row could be read as an amendment's.
--
-- NOTE on steady state: the shared so_outbox_vacuum job (03) deletes `done` rows
-- older than 30 days for EVERY entity, and this function re-queues anything with
-- no `done` row. So each amendment is re-sent once, ~30 days after its last
-- delivery, then settles. That is harmless (the receiver's upsert is idempotent
-- and the values are identical) but it means this function does NOT return 0 in
-- steady state, contrary to 03's comment on the SO equivalent. Do not alarm on
-- `> 0` alone. The SO path has this same property today.
CREATE OR REPLACE FUNCTION reconcile_amendment_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE n INT;
BEGIN
  INSERT INTO sync_outbox(entity, entity_key, op, status)
  SELECT 'so_amendment', a.id::text, 'RECONCILE', 'pending'
    FROM so_amendments a
   WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox o
            WHERE o.entity = 'so_amendment' AND o.entity_key = a.id::text AND o.status = 'done')
     AND NOT EXISTS (
           SELECT 1 FROM sync_outbox o                 -- don't pile up duplicates
            WHERE o.entity = 'so_amendment' AND o.entity_key = a.id::text
              AND o.status IN ('pending','sent'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;


-- ---- 5. SCHEDULE: three NEW cron jobs, parallel to the SO mirror's ------------
-- Separate job names => the SO mirror's schedules are untouched. Unschedule
-- first so a re-paste does not stack duplicate jobs.
SELECT cron.unschedule('amendment_outbox_drain')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'amendment_outbox_drain');
SELECT cron.unschedule('amendment_outbox_confirm')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'amendment_outbox_confirm');
SELECT cron.unschedule('amendment_outbox_reconcile') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'amendment_outbox_reconcile');

SELECT cron.schedule('amendment_outbox_drain',     '10 seconds', 'SELECT drain_amendment_outbox();');
SELECT cron.schedule('amendment_outbox_confirm',   '15 seconds', 'SELECT confirm_amendment_outbox();');
SELECT cron.schedule('amendment_outbox_reconcile', '0 * * * *',  'SELECT reconcile_amendment_outbox();');


-- ---- 6. BACKFILL: enqueue every existing amendment once -----------------------
-- So the first drain mirrors the amendments that already exist (including any
-- currently OPEN request the owner wants to see). Idempotent: the receiver
-- upserts by the verbatim uuid.
INSERT INTO sync_outbox(entity, entity_key, op)
SELECT 'so_amendment', id::text, 'BACKFILL' FROM so_amendments;


-- ============================================================================
-- TURNING IT ON (run separately, AFTER verifying the above applied cleanly)
-- ============================================================================
-- Nothing mirrors until these three rows exist: `enabled_entities` gates the
-- drain, so the code above is inert until you opt in.
--
--   INSERT INTO sync_config VALUES ('houzs_amendment_url','https://<houzs-host>/api/sync/amendment-mirror')
--     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
--   -- sync_secret already exists from 02; do NOT change it (the SO mirror uses it).
--   INSERT INTO sync_config VALUES ('enabled_entities','so_amendment')
--     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
--
-- KILL SWITCH (instant, no deploy):
--   UPDATE sync_config SET v = '' WHERE k = 'enabled_entities';
--   -- the amendment drain no-ops on the next tick; the SO mirror is unaffected.
--
-- VERIFY (read-only):
--   SELECT entity, status, count(*) FROM sync_outbox GROUP BY 1,2 ORDER BY 1,2;
--   SELECT entity_key, attempts, last_error FROM sync_outbox
--    WHERE entity='so_amendment' AND status='pending' AND attempts > 0;
--   -- last_error 'http 500' => read the body Houzs returned:
--   SELECT o.entity_key, r.status_code, r.content FROM sync_outbox o
--     JOIN net._http_response r ON r.id = o.http_request_id
--    WHERE o.entity = 'so_amendment' ORDER BY o.id DESC LIMIT 20;
-- ============================================================================
