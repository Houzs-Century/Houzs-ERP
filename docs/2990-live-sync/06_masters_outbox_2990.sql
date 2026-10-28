-- ============================================================================
-- 2990 -> Houzs LIVE STAFF + WAREHOUSE mirror — OUTBOX + DRAIN + CONFIRM +
-- RECONCILE. Applies to the 2990 SOURCE database. Paste into the Supabase SQL
-- editor. Apply AFTER 01/02/03 (this reuses their sync_outbox + sync_config
-- tables). Independent of 04 and 05 — no file here needs the others.
--
-- WHAT THIS IS FOR: this CLOSES the masters phase. 05 fixed customers after they
-- wedged SO-2607-013 for 27+ hours across 6982 attempts. staff and warehouses are
-- the LAST TWO FK parents of the mirrored SO trio that can wedge it the same way,
-- and neither can self-heal today. This is design D6 — "masters mirror first, or
-- everything else 500s" — applied to the rest of the surface instead of one
-- column at a time.
--
-- The SO trio's COMPLETE FK surface, and why it ends here:
--   customers   -> FIXED by 05 (63=63, drift 0).
--   staff       -> THIS FILE. mfg_sales_orders.salesperson_id, .created_by and
--                  mfg_sales_order_payments.collected_by are live FKs to
--                  scm.staff. One 2990 hire after the one-time import wedges that
--                  person's first SO forever. amendment-mirror.ts has carried the
--                  note "This does NOT self-heal" since it landed.
--   warehouses  -> THIS FILE. mfg_sales_order_items.warehouse_id is a live FK to
--                  scm.warehouses. Same frozen-import shape.
--   venues      -> CANNOT wedge: so-mirror forces venue_id NULL on every SO.
--   products/series/categories -> CANNOT wedge: SO items carry no product FK.
-- drivers / lorries / accounts / currencies are NOT part of this bug and are NOT
-- touched here: they were never in the importer's 33 tables and are not SO
-- parents.
--
-- ONE-WAY only. Houzs never writes 2990's staff list or warehouse list.
--
-- ============================================================================
-- THE ONE RULE THIS FILE EXISTS TO RESPECT: DO NOT TOUCH THE WORKING SO MIRROR.
-- ============================================================================
-- drain_so_outbox(), enqueue_so_outbox(), enqueue_so_outbox_child(), their three
-- triggers and their two cron jobs are FROZEN. Nothing below alters, replaces or
-- drops any of them. This file only ADDS: two trigger functions, two triggers,
-- six functions and six cron jobs, carrying entity = 'staff' / 'warehouse'. The
-- SO mirror keeps running untouched alongside. If this whole file were reverted,
-- the SO mirror would not notice.
--
-- TWO ENTITIES, TWO INDEPENDENT DRAINS — deliberately not one "masters" drain.
-- staff and warehouses fail for different reasons and must not share a fate: a
-- warehouse that cannot deliver must never delay a staff row, because a staff row
-- is what unwedges an SO. Separate entity values + separate drains + separate
-- cron jobs = separate blast radius, and either can be killed alone (see the CSV
-- kill switch at the bottom).
--
-- ---------------------------------------------------------------------------
-- WHY entity_key IS THE uuid — LOAD-BEARING (same reasoning as 04 and 05)
-- ---------------------------------------------------------------------------
-- We share the sync_outbox TABLE with the SO path, and two of the SO path's
-- functions read that table WITHOUT filtering on `entity`:
--
--   * reconcile_so_outbox() (03) re-queues any SO with no `done` row, matching
--     ONLY on `o.entity_key = so.doc_no`. A staff/warehouse entity_key is a uuid,
--     and a uuid is never equal to a doc_no, so a delivered MASTER row can never
--     be misread as proof that a SALES ORDER was delivered. Had we keyed these by
--     anything doc-no-shaped, this file could have silently suppressed the SO
--     mirror's self-heal.
--   * confirm_so_outbox() (02) confirms every row in status 'sent' regardless of
--     entity, so it WILL also confirm the rows this file enqueues. Harmless — it
--     reads the same net._http_response row and applies the same 2xx/else branch
--     as the confirms below, so both compute the same result and the row lock
--     serialises them. Documented, not relied on: our own confirms are
--     entity-filtered and correct on their own.
--
-- Every function BELOW filters on entity. The asymmetry is deliberate: we accept
-- the frozen path's looseness rather than "fix" it and risk the one link that
-- works.
--
-- ---------------------------------------------------------------------------
-- POS SAFETY: same contract as 01/04/05. Both trigger functions swallow their
-- own errors. An outbox failure must NEVER roll back or block a 門店 sale — and
-- `staff` is on the POS's own login path. A raise here would take down the till.
-- Missed rows are backfilled by the reconcile functions below.
--
-- Idempotent / re-runnable: IF NOT EXISTS + CREATE OR REPLACE + DROP TRIGGER IF
-- + cron.unschedule guards. Safe to paste twice.
-- ============================================================================


-- ============================================================================
-- PART A — STAFF
-- ============================================================================

-- ---- A1. TRIGGER: capture every staff change, in the same transaction --------
CREATE OR REPLACE FUNCTION enqueue_staff_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  BEGIN
    INSERT INTO sync_outbox(entity, entity_key, op)
    VALUES ('staff', COALESCE(NEW.id, OLD.id)::text, TG_OP);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never block the write; reconciliation backfills a missed row
  END;
  RETURN NULL;  -- AFTER trigger: return value ignored
END $fn$;

DROP TRIGGER IF EXISTS trg_staff_outbox ON staff;
CREATE TRIGGER trg_staff_outbox
  AFTER INSERT OR UPDATE OR DELETE ON staff
  FOR EACH ROW EXECUTE FUNCTION enqueue_staff_outbox();


-- ---- A2. DRAIN: build each pending staff payload, POST it, mark 'sent' -------
-- Config keys read (set out-of-band, NOT committed — see "TURNING IT ON"):
--   houzs_staff_url  — https://<houzs>/api/sync/staff-mirror
--   sync_secret      — shared with the SO mirror (same Houzs Worker, same
--                      SYNC_SECRET); reused deliberately, not duplicated.
--   enabled_entities — CSV kill switch (D8). MISSING/absent => this drain
--                      no-ops, so the feature ships DARK and is turned on by
--                      adding to a row, with no deploy.
--
-- NOTE ON DELETE: a 2990 staff DELETE is still enqueued and still delivered —
-- the receiver answers 2xx and deliberately does NOTHING (staff-mirror.ts has
-- the full ruling: 20 of the 41 FKs into scm.staff are ON DELETE SET NULL, so a
-- delete would silently erase salesperson attribution on real orders; 4 are
-- CASCADE, which would drop commission rows; and the other 17 would RAISE and
-- retry forever). We send it rather than filter it here so the outbox reaches a
-- terminal 'done' state instead of retrying, and so the ruling lives in ONE place
-- (the receiver) rather than being half-encoded in 2990's SQL.
CREATE OR REPLACE FUNCTION drain_staff_outbox(batch INT DEFAULT 50) RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE
  v_url TEXT; v_secret TEXT; v_entities TEXT; r RECORD; payload JSONB; req BIGINT; n INT := 0;
BEGIN
  SELECT v INTO v_entities FROM sync_config WHERE k = 'enabled_entities';
  IF NOT ('staff' = ANY(string_to_array(COALESCE(v_entities, ''), ','))) THEN
    RETURN 0;  -- kill switch / not yet enabled
  END IF;

  SELECT v INTO v_url    FROM sync_config WHERE k = 'houzs_staff_url';
  SELECT v INTO v_secret FROM sync_config WHERE k = 'sync_secret';
  IF v_url IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT DISTINCT entity_key
      FROM sync_outbox
     WHERE status = 'pending' AND entity = 'staff'
     ORDER BY entity_key
     LIMIT batch
  LOOP
    IF EXISTS (SELECT 1 FROM staff WHERE id = r.entity_key::uuid) THEN
      SELECT jsonb_build_object('staffId', s.id, 'staff', to_jsonb(s))
        INTO payload
        FROM staff s WHERE s.id = r.entity_key::uuid;
    ELSE
      payload := jsonb_build_object('staffId', r.entity_key, 'deleted', true);
    END IF;

    req := net.http_post(
      url                  := v_url,
      body                 := payload,
      headers              := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
      timeout_milliseconds := 8000);

    -- `AND entity = 'staff'`: never flip an SO row's status/http_request_id.
    -- The uuid key already makes a collision impossible; this makes it structural.
    UPDATE sync_outbox SET status = 'sent', http_request_id = req, attempts = attempts + 1
     WHERE entity_key = r.entity_key AND entity = 'staff' AND status = 'pending';
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;


-- ---- A3. CONFIRM: 2xx => done; anything else => back to pending (retry) ------
CREATE OR REPLACE FUNCTION confirm_staff_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT o.id, resp.status_code
      FROM sync_outbox o
      JOIN net._http_response resp ON resp.id = o.http_request_id
     WHERE o.status = 'sent' AND o.entity = 'staff'
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


-- ---- A4. RECONCILE / SELF-HEAL ----------------------------------------------
-- Any staff row with no successfully-delivered row gets a fresh pending row.
-- Entity-filtered on BOTH sub-queries — without that, an SO's 'done' row could be
-- read as a staff row's. See 05's note on steady state: the shared vacuum (03)
-- deletes `done` rows older than 30 days, so each row is re-sent once ~30 days
-- after its last delivery and then settles. Do NOT alarm on `> 0` alone.
CREATE OR REPLACE FUNCTION reconcile_staff_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE n INT;
BEGIN
  INSERT INTO sync_outbox(entity, entity_key, op, status)
  SELECT 'staff', s.id::text, 'RECONCILE', 'pending'
    FROM staff s
   WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox o
            WHERE o.entity = 'staff' AND o.entity_key = s.id::text AND o.status = 'done')
     AND NOT EXISTS (
           SELECT 1 FROM sync_outbox o                 -- don't pile up duplicates
            WHERE o.entity = 'staff' AND o.entity_key = s.id::text
              AND o.status IN ('pending','sent'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;


-- ============================================================================
-- PART B — WAREHOUSES
-- ============================================================================

-- ---- B1. TRIGGER -------------------------------------------------------------
CREATE OR REPLACE FUNCTION enqueue_warehouse_outbox() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  BEGIN
    INSERT INTO sync_outbox(entity, entity_key, op)
    VALUES ('warehouse', COALESCE(NEW.id, OLD.id)::text, TG_OP);
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never block the write; reconciliation backfills a missed row
  END;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS trg_warehouse_outbox ON warehouses;
CREATE TRIGGER trg_warehouse_outbox
  AFTER INSERT OR UPDATE OR DELETE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION enqueue_warehouse_outbox();


-- ---- B2. DRAIN ---------------------------------------------------------------
-- Config key: houzs_warehouse_url — https://<houzs>/api/sync/warehouse-mirror
--
-- NOTE ON DELETE: a 2990 warehouse DELETE is delivered, and the receiver
-- DEACTIVATES (is_active=false) rather than deleting. Houzs holds a FROZEN
-- snapshot of 2990's inventory_lots / inventory_movements /
-- inventory_lot_consumptions (all three are in the importer's 33 tables) and
-- those carry ON DELETE RESTRICT FKs to warehouses — so 2990 can legally drop a
-- warehouse it has cleared while Houzs's stale copy still references it, and a
-- hard delete would RAISE and retry forever. See warehouse-mirror.ts.
CREATE OR REPLACE FUNCTION drain_warehouse_outbox(batch INT DEFAULT 50) RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE
  v_url TEXT; v_secret TEXT; v_entities TEXT; r RECORD; payload JSONB; req BIGINT; n INT := 0;
BEGIN
  SELECT v INTO v_entities FROM sync_config WHERE k = 'enabled_entities';
  IF NOT ('warehouse' = ANY(string_to_array(COALESCE(v_entities, ''), ','))) THEN
    RETURN 0;  -- kill switch / not yet enabled
  END IF;

  SELECT v INTO v_url    FROM sync_config WHERE k = 'houzs_warehouse_url';
  SELECT v INTO v_secret FROM sync_config WHERE k = 'sync_secret';
  IF v_url IS NULL THEN RETURN 0; END IF;

  FOR r IN
    SELECT DISTINCT entity_key
      FROM sync_outbox
     WHERE status = 'pending' AND entity = 'warehouse'
     ORDER BY entity_key
     LIMIT batch
  LOOP
    IF EXISTS (SELECT 1 FROM warehouses WHERE id = r.entity_key::uuid) THEN
      SELECT jsonb_build_object('warehouseId', w.id, 'warehouse', to_jsonb(w))
        INTO payload
        FROM warehouses w WHERE w.id = r.entity_key::uuid;
    ELSE
      payload := jsonb_build_object('warehouseId', r.entity_key, 'deleted', true);
    END IF;

    req := net.http_post(
      url                  := v_url,
      body                 := payload,
      headers              := jsonb_build_object('Content-Type','application/json','x-sync-secret', v_secret),
      timeout_milliseconds := 8000);

    UPDATE sync_outbox SET status = 'sent', http_request_id = req, attempts = attempts + 1
     WHERE entity_key = r.entity_key AND entity = 'warehouse' AND status = 'pending';
    n := n + 1;
  END LOOP;
  RETURN n;
END $fn$;


-- ---- B3. CONFIRM -------------------------------------------------------------
CREATE OR REPLACE FUNCTION confirm_warehouse_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE r RECORD; n INT := 0;
BEGIN
  FOR r IN
    SELECT o.id, resp.status_code
      FROM sync_outbox o
      JOIN net._http_response resp ON resp.id = o.http_request_id
     WHERE o.status = 'sent' AND o.entity = 'warehouse'
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


-- ---- B4. RECONCILE / SELF-HEAL ----------------------------------------------
CREATE OR REPLACE FUNCTION reconcile_warehouse_outbox() RETURNS INT
LANGUAGE plpgsql AS $fn$
DECLARE n INT;
BEGIN
  INSERT INTO sync_outbox(entity, entity_key, op, status)
  SELECT 'warehouse', w.id::text, 'RECONCILE', 'pending'
    FROM warehouses w
   WHERE NOT EXISTS (
           SELECT 1 FROM sync_outbox o
            WHERE o.entity = 'warehouse' AND o.entity_key = w.id::text AND o.status = 'done')
     AND NOT EXISTS (
           SELECT 1 FROM sync_outbox o
            WHERE o.entity = 'warehouse' AND o.entity_key = w.id::text
              AND o.status IN ('pending','sent'));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;


-- ============================================================================
-- PART C — SCHEDULE: six NEW cron jobs, parallel to the SO mirror's
-- ============================================================================
-- Separate job names => the SO mirror's schedules are untouched. Unschedule
-- first so a re-paste does not stack duplicate jobs.
SELECT cron.unschedule('staff_outbox_drain')         WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'staff_outbox_drain');
SELECT cron.unschedule('staff_outbox_confirm')       WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'staff_outbox_confirm');
SELECT cron.unschedule('staff_outbox_reconcile')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'staff_outbox_reconcile');
SELECT cron.unschedule('warehouse_outbox_drain')     WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'warehouse_outbox_drain');
SELECT cron.unschedule('warehouse_outbox_confirm')   WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'warehouse_outbox_confirm');
SELECT cron.unschedule('warehouse_outbox_reconcile') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'warehouse_outbox_reconcile');

SELECT cron.schedule('staff_outbox_drain',         '10 seconds', 'SELECT drain_staff_outbox();');
SELECT cron.schedule('staff_outbox_confirm',       '15 seconds', 'SELECT confirm_staff_outbox();');
SELECT cron.schedule('staff_outbox_reconcile',     '0 * * * *',  'SELECT reconcile_staff_outbox();');
SELECT cron.schedule('warehouse_outbox_drain',     '10 seconds', 'SELECT drain_warehouse_outbox();');
SELECT cron.schedule('warehouse_outbox_confirm',   '15 seconds', 'SELECT confirm_warehouse_outbox();');
SELECT cron.schedule('warehouse_outbox_reconcile', '0 * * * *',  'SELECT reconcile_warehouse_outbox();');


-- ============================================================================
-- PART D — BACKFILL: enqueue every existing staff row + warehouse once
-- ============================================================================
-- ~16 staff rows and 2990's handful of warehouses. Idempotent: the receivers
-- upsert by the verbatim uuid.
--
-- The staff backfill also CLEANS a latent import artifact. The batch import ran
-- under `SET session_replication_role = replica` (FK checks OFF) and did not null
-- staff.showroom_id — but scm.showrooms is EMPTY in Houzs (showrooms is not in
-- the importer's 33 tables and 0022 does not seed it). So any imported staff row
-- may be carrying a dangling showroom_id right now. The receiver forces
-- showroom_id and venue_id NULL, so re-delivering all 16 rows repairs them.
-- (Rows already relinked by PR #688 keep user_id NOT NULL and are correctly left
-- alone — see staff-mirror.ts. Their dangling showroom_id, if any, is inert:
-- Postgres only re-checks an FK when the referencing column is written.)
INSERT INTO sync_outbox(entity, entity_key, op)
SELECT 'staff', id::text, 'BACKFILL' FROM staff;

INSERT INTO sync_outbox(entity, entity_key, op)
SELECT 'warehouse', id::text, 'BACKFILL' FROM warehouses;


-- ============================================================================
-- TURNING IT ON (run separately, AFTER verifying the above applied cleanly)
-- ============================================================================
-- Nothing mirrors until these rows exist: `enabled_entities` gates both drains,
-- so everything above is inert until you opt in.
--
--   INSERT INTO sync_config VALUES ('houzs_staff_url','https://<houzs-host>/api/sync/staff-mirror')
--     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
--   INSERT INTO sync_config VALUES ('houzs_warehouse_url','https://<houzs-host>/api/sync/warehouse-mirror')
--     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
--   -- sync_secret already exists from 02; do NOT change it (the SO mirror uses it).
--
-- enabled_entities is a SHARED CSV. Do NOT overwrite it — ADD to it, or you will
-- silently switch off whatever else is already enabled ('customer' from 05 and
-- 'so_amendment' from 04 are BOTH LIVE). This append is idempotent and
-- order-independent, and adds both entities at once:
--
--   INSERT INTO sync_config(k, v) VALUES ('enabled_entities','staff,warehouse')
--     ON CONFLICT (k) DO UPDATE SET v = (
--       SELECT string_agg(DISTINCT e, ',')
--         FROM unnest(string_to_array(sync_config.v || ',staff,warehouse', ',')) AS e
--        WHERE e <> '');
--
--   -- confirm what is enabled before walking away — expect customer + so_amendment
--   -- to still be there:
--   SELECT v FROM sync_config WHERE k = 'enabled_entities';
--
-- RECOMMENDED: enable 'staff' FIRST, on its own, and let it settle before adding
-- 'warehouse'. staff is the one with a known live consequence (it unwedges SOs);
-- warehouse is insurance. Enabling them one at a time keeps the diagnosis of any
-- 500 unambiguous:
--
--   INSERT INTO sync_config(k, v) VALUES ('enabled_entities','staff')
--     ON CONFLICT (k) DO UPDATE SET v = (
--       SELECT string_agg(DISTINCT e, ',')
--         FROM unnest(string_to_array(sync_config.v || ',staff', ',')) AS e
--        WHERE e <> '');
--
-- KILL SWITCH (instant, no deploy) — removes ONLY these two, leaves the rest:
--   UPDATE sync_config SET v = (
--     SELECT COALESCE(string_agg(e, ','), '')
--       FROM unnest(string_to_array(v, ',')) AS e
--      WHERE e NOT IN ('staff','warehouse') AND e <> '')
--    WHERE k = 'enabled_entities';
--   -- both drains no-op on the next tick; the SO mirror is unaffected
--   -- (drain_so_outbox does not read enabled_entities at all), and so are the
--   -- customer + amendment mirrors.
--
-- VERIFY (read-only):
--   SELECT entity, status, count(*) FROM sync_outbox GROUP BY 1,2 ORDER BY 1,2;
--   -- the two that matter — expect 0 rows once drained:
--   SELECT entity, entity_key, attempts, last_error FROM sync_outbox
--    WHERE entity IN ('staff','warehouse') AND status='pending' AND attempts > 0;
--   -- last_error 'http 500' => read the body Houzs returned:
--   SELECT o.entity, o.entity_key, r.status_code, r.content FROM sync_outbox o
--     JOIN net._http_response r ON r.id = o.http_request_id
--    WHERE o.entity IN ('staff','warehouse') ORDER BY o.id DESC LIMIT 20;
--
-- READING A 500 (the three that are worth naming):
--   * 'column "company_id" of relation "staff" does not exist' => the receiver is
--     stamping company_id on a shared master. scm.staff HAS NO company_id by
--     design (0083). Fix the receiver, not the schema — do NOT add the column.
--   * 'staff_staff_code_unique' / 'staff_email_unique' => a 2990 staff_code or
--     email collides with a HOUZS-NATIVE staff row. These uniques are GLOBAL and,
--     unlike customers (0123) and warehouses (0087), CANNOT be re-scoped by
--     company_id — staff has none. This should not happen: the namespaces are
--     disjoint (2990 mints 2990S-###/OPS, Houzs mig 0066 mints EMP-####) and
--     0066 never writes staff.email, so Houzs rows carry email NULL and UNIQUE
--     ignores NULLs. If it fires, renumber the colliding row by hand.
--   * 'warehouses_code_unique' => the PRE-0087 global index is still in place;
--     Houzs migration 0087 has not applied. Fix that, not this file. (The
--     post-0087 name is warehouses_company_code_unique — seeing THAT one means
--     two 2990 warehouses share a code, which is a 2990 data problem.)
--
-- WHAT "WORKING" LOOKS LIKE, measured on the Houzs side:
--   -- 2990 staff = 16. Expect the same 16 uuids present in Houzs, all inactive
--   -- (except any PR #688 has relinked, which are live Houzs employees):
--   SELECT count(*) FROM scm.staff WHERE user_id IS NULL
--     AND id <> '00000000-0000-4000-8000-000000000001';
--   SELECT count(*) FROM scm.staff WHERE user_id IS NULL AND showroom_id IS NOT NULL;  -- expect 0 after backfill
-- ============================================================================
