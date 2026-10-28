-- ============================================================================
-- 2990 -> Houzs LIVE CUSTOMER mirror — OUTBOX + DRAIN + CONFIRM + RECONCILE
-- Applies to the 2990 SOURCE database. Paste into the Supabase SQL editor.
-- Apply AFTER 01/02/03 (this reuses their sync_outbox + sync_config tables).
-- Independent of 04 — neither file needs the other.
--
-- WHAT THIS IS FOR: THIS FIXES A LIVE PRODUCTION BUG. It is design D6 ("masters
-- mirror first, or everything else 500s") and design risk R3, which is not a
-- risk any more — it has fired.
--
-- scm.mfg_sales_orders.customer_id in Houzs carries a live, enforced FK to
-- scm.customers. SOs mirror LIVE, but customers were a ONE-TIME frozen import
-- (migrate-2990-into-houzs.mjs, 33 tables, ON CONFLICT DO NOTHING, never
-- updates). So a 2990 customer created after that import does not exist in
-- Houzs, and that customer's first SO fails the FK -> Houzs 500 -> this outbox
-- retries forever -> the SO NEVER LANDS. SO-2607-013 has been wedged for 27+
-- hours across 6582 attempts on exactly this: every other FK it holds
-- (created_by, salesperson_id, venue_id, warehouse_id) resolves; customer_id
-- 7024b9ac-84af-456d-8b45-74af572e9ae0 does not exist in Houzs. 2990 has 67
-- customers, Houzs has 66. One missing customer, one stuck SO.
--
-- ONE-WAY only. Houzs never writes 2990's customer book (design §2a row 2).
--
-- ============================================================================
-- THE ONE RULE THIS FILE EXISTS TO RESPECT: DO NOT TOUCH THE WORKING SO MIRROR.
-- ============================================================================
-- drain_so_outbox(), enqueue_so_outbox(), enqueue_so_outbox_child(), their three
-- triggers and their two cron jobs are FROZEN. Nothing below alters, replaces or
-- drops any of them. This file only ADDS: one trigger function, one trigger,
-- three functions and three cron jobs, all carrying entity = 'customer'. The SO
-- mirror keeps running untouched alongside. If this whole file were reverted, the
-- SO mirror would not notice.
--
-- ---------------------------------------------------------------------------
-- WHY entity_key IS THE CUSTOMER uuid — LOAD-BEARING (same reasoning as 04)
-- ---------------------------------------------------------------------------
-- We share the sync_outbox TABLE with the SO path, and two of the SO path's
-- functions read that table WITHOUT filtering on `entity`:
--
--   * reconcile_so_outbox() (03) re-queues any SO with no `done` row, matching
--     ONLY on `o.entity_key = so.doc_no`. A customer's entity_key is a uuid, and
--     a uuid is never equal to a doc_no, so a delivered CUSTOMER row can never be
--     misread as proof that a SALES ORDER was delivered. Had we keyed customers
--     by anything doc-no-shaped, this file could have silently suppressed the SO
--     mirror's self-heal — the exact failure 04 was written to avoid.
--   * confirm_so_outbox() (02) confirms every row in status 'sent' regardless of
--     entity, so it WILL also confirm the rows this file enqueues. That is
--     harmless — it reads the same net._http_response row and applies the same
--     2xx/else branch as confirm_customer_outbox() below, so both compute the
--     same result and the row lock serialises them. Documented, not relied on:
--     our own confirm is entity-filtered and correct on its own.
--
-- Every function BELOW filters on entity. The asymmetry is deliberate: we accept
-- the frozen path's looseness rather than "fix" it and risk the one link that
-- works.
--
-- ---------------------------------------------------------------------------
-- POS SAFETY: same contract as 01/04. The trigger function swallows its own
-- errors. An outbox failure must NEVER roll back or block a 門店 sale — and this
-- trigger sits on `customers`, which 2990 writes on EVERY SO create via
-- upsert_customer_by_name_phone() (it bumps last_seen_at on a returning
-- customer). That makes this the highest-traffic trigger of the three mirrors and
-- the one where swallowing matters most: a raise here would take down the till.
-- Missed rows are backfilled by reconcile_customer_outbox() below.
--
-- Idempotent / re-runnable: IF NOT EXISTS + CREATE OR REPLACE + DROP TRIGGER IF
-- + cron.unschedule guards. Safe to paste twice.
-- ============================================================================


-- ---- 1. TRIGGER: capture every customer change, in the same transaction ------
-- entity_key = the customer's uuid (see the note above).
CREATE OR REPLACE FUNCTION enqueue_customer_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  BEGIN
    INSERT INTO sync_outbox(entity, entity_key, op)
    VALUES ('customer', COALESCE(NEW.id, OLD.id)::text, TG_OP);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never block the write; reconciliation backfills a missed row
  END;
  RETURN NULL;  -- AFTER trigger: return value ignored
END $fn$;

DROP TRIGGER IF EXISTS trg_customer_outbox ON customers;
CREATE TRIGGER trg_customer_outbox
  AFTER INSERT OR UPDATE OR DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION enqueue_customer_outbox();

-- No child trigger: customers has no child table in the mirrored set. (Contrast
-- 04, where a line edit must re-forward the parent amendment.)


-- ---- 2. DRAIN: build each pending customer's payload, POST it, mark 'sent' ---
-- A THIRD, PARALLEL drain. drain_so_outbox() is untouched and unaware of this.
--
-- Config keys read (set out-of-band, NOT committed — see step 5 below):
--   houzs_customer_url — https://<houzs>/api/sync/customer-mirror
--   sync_secret        — shared with the SO mirror (same Houzs Worker, same
--                        SYNC_SECRET); reused deliberately, not duplicated.
--   enabled_entities   — CSV kill switch (D8). MISSING/absent => this drain
--                        no-ops, so the feature ships DARK and is turned on by
--                        adding a row, with no deploy. Removing 'customer' from
--                        the CSV stops the customer mirror INSTANTLY and leaves
--                        the SO mirror running.
CREATE OR REPLACE FUNCTION drain_customer_outbox(batch INT DEFAULT 50) RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE
  v_url TEXT; v_secret TEXT; v_entities TEXT; r RECORD; payload JSONB; req BIGINT; n INT := 0;
BEGIN
  SELECT v INTO v_entities FROM sync_config WHERE k = 'enabled_entities';
  IF NOT ('customer' = ANY(string_to_array(COALESCE(v_entities, ''), ','))) THEN
    RETURN 0;  -- kill switch / not yet enabled
  END IF;

  SELECT v INTO v_url    FROM sync_config WHERE k = 'houzs_customer_url';
  SELECT v INTO v_secret FROM sync_config WHERE k = 'sync_secret';
  IF v_url IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT DISTINCT entity_key
      FROM sync_outbox
     WHERE status = 'pending' AND entity = 'customer'
     ORDER BY entity_key
     LIMIT batch
  LOOP
    IF EXISTS (SELECT 1 FROM customers WHERE id = r.entity_key::uuid) THEN
      SELECT jsonb_build_object(
               'customerId', c.id,
               'customer',   to_jsonb(c))
        INTO payload
        FROM customers c WHERE c.id = r.entity_key::uuid;
    ELSE
      payload := jsonb_build_object('customerId', r.entity_key, 'deleted', true);
    END IF;

    req := net.http_post(
      url                  := v_url,
      body                 := payload,
      headers              := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
      timeout_milliseconds := 8000);

    -- `AND entity = 'customer'`: never flip an SO row's status/http_request_id.
    -- The uuid key already makes a collision impossible; this makes it structural.
    UPDATE sync_outbox SET status = 'sent', http_request_id = req, attempts = attempts + 1
     WHERE entity_key = r.entity_key AND entity = 'customer' AND status = 'pending';
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;


-- ---- 3. CONFIRM: 2xx => done; anything else => back to pending (retry) -------
-- Entity-filtered mirror of confirm_so_outbox(). See the header note: the SO
-- confirm is NOT entity-filtered and will also process these rows, identically.
CREATE OR REPLACE FUNCTION confirm_customer_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT o.id, resp.status_code
      FROM sync_outbox o
      JOIN net._http_response resp ON resp.id = o.http_request_id
     WHERE o.status = 'sent' AND o.entity = 'customer'
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
-- Any customer with no successfully-delivered row gets a fresh pending row.
-- Backstop for a trigger-missed row (the trigger swallows errors) or a
-- permanently-failed delivery. Entity-filtered on BOTH sub-queries — without
-- that, an SO's 'done' row could be read as a customer's.
--
-- NOTE on steady state: the shared so_outbox_vacuum job (03) deletes `done` rows
-- older than 30 days for EVERY entity, and this function re-queues anything with
-- no `done` row. So each customer is re-sent once, ~30 days after its last
-- delivery, then settles. That is harmless (the receiver's upsert is idempotent
-- and the values are identical) but it means this function does NOT return 0 in
-- steady state. Do not alarm on `> 0` alone. The SO path has this same property.
CREATE OR REPLACE FUNCTION reconcile_customer_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE n INT;
BEGIN
  INSERT INTO sync_outbox(entity, entity_key, op, status)
  SELECT 'customer', c.id::text, 'RECONCILE', 'pending'
    FROM customers c
   WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox o
            WHERE o.entity = 'customer' AND o.entity_key = c.id::text AND o.status = 'done')
     AND NOT EXISTS (
           SELECT 1 FROM sync_outbox o                 -- don't pile up duplicates
            WHERE o.entity = 'customer' AND o.entity_key = c.id::text
              AND o.status IN ('pending','sent'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;


-- ---- 5. SCHEDULE: three NEW cron jobs, parallel to the SO mirror's ------------
-- Separate job names => the SO mirror's schedules are untouched. Unschedule
-- first so a re-paste does not stack duplicate jobs.
SELECT cron.unschedule('customer_outbox_drain')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'customer_outbox_drain');
SELECT cron.unschedule('customer_outbox_confirm')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'customer_outbox_confirm');
SELECT cron.unschedule('customer_outbox_reconcile') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'customer_outbox_reconcile');

SELECT cron.schedule('customer_outbox_drain',     '10 seconds', 'SELECT drain_customer_outbox();');
SELECT cron.schedule('customer_outbox_confirm',   '15 seconds', 'SELECT confirm_customer_outbox();');
SELECT cron.schedule('customer_outbox_reconcile', '0 * * * *',  'SELECT reconcile_customer_outbox();');


-- ---- 6. BACKFILL: enqueue every existing customer once ------------------------
-- THIS IS WHAT UNWEDGES SO-2607-013. No one-shot script is needed: this enqueues
-- all 67 customers including the missing 7024b9ac-…, the first drain delivers
-- them, and the SO mirror then heals ITSELF — drain_so_outbox() re-reads the SO
-- live from mfg_sales_orders on every tick (it does not replay a payload
-- snapshotted at enqueue time), and SO-2607-013's outbox row is still 'pending'
-- because confirm_so_outbox() keeps putting it back there on every 500. So the
-- very next 10s tick after the customer lands re-POSTs the same SO, the FK now
-- resolves, Houzs returns 2xx, and confirm marks it done. Nothing needs
-- re-enqueuing by hand.
-- Idempotent: the receiver upserts by the verbatim uuid.
INSERT INTO sync_outbox(entity, entity_key, op)
SELECT 'customer', id::text, 'BACKFILL' FROM customers;


-- ============================================================================
-- TURNING IT ON (run separately, AFTER verifying the above applied cleanly)
-- ============================================================================
-- Nothing mirrors until these rows exist: `enabled_entities` gates the drain, so
-- the code above is inert until you opt in.
--
--   INSERT INTO sync_config VALUES ('houzs_customer_url','https://<houzs-host>/api/sync/customer-mirror')
--     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
--   -- sync_secret already exists from 02; do NOT change it (the SO mirror uses it).
--
-- enabled_entities is a SHARED CSV. Do NOT overwrite it — ADD to it, or you will
-- silently switch off whatever else is already enabled (e.g. 'so_amendment' from
-- 04). This append is idempotent and order-independent:
--
--   INSERT INTO sync_config(k, v) VALUES ('enabled_entities','customer')
--     ON CONFLICT (k) DO UPDATE SET v = (
--       SELECT string_agg(DISTINCT e, ',')
--         FROM unnest(string_to_array(sync_config.v || ',customer', ',')) AS e
--        WHERE e <> '');
--
--   -- confirm what is enabled before walking away:
--   SELECT v FROM sync_config WHERE k = 'enabled_entities';
--
-- KILL SWITCH (instant, no deploy) — removes ONLY 'customer', leaves the rest:
--   UPDATE sync_config SET v = (
--     SELECT COALESCE(string_agg(e, ','), '')
--       FROM unnest(string_to_array(v, ',')) AS e
--      WHERE e <> 'customer' AND e <> '')
--    WHERE k = 'enabled_entities';
--   -- the customer drain no-ops on the next tick; the SO mirror is unaffected
--   -- (drain_so_outbox does not read enabled_entities at all).
--
-- VERIFY (read-only):
--   SELECT entity, status, count(*) FROM sync_outbox GROUP BY 1,2 ORDER BY 1,2;
--   -- the money shot — SO-2607-013 should go 'pending' -> 'done' within ~20s of
--   -- the customers draining:
--   SELECT entity_key, status, attempts, last_error FROM sync_outbox
--    WHERE entity_key = 'SO-2607-013';
--   SELECT entity_key, attempts, last_error FROM sync_outbox
--    WHERE entity='customer' AND status='pending' AND attempts > 0;
--   -- last_error 'http 500' => read the body Houzs returned:
--   SELECT o.entity_key, r.status_code, r.content FROM sync_outbox o
--     JOIN net._http_response r ON r.id = o.http_request_id
--    WHERE o.entity = 'customer' ORDER BY o.id DESC LIMIT 20;
--   -- a reason of 'customers_name_phone_unique' or 'customers_customer_code_unique'
--   -- means Houzs migration 0123 has not applied. Fix that, not this file.
-- ============================================================================
