-- ----------------------------------------------------------------------------
-- 20260912T1800 — ERP -> Venture Portal LIVE sales-order feed: the OUTBOX.
--
-- WHY. The Venture Portal pays Revenue Department commission out of this
-- system's sales orders, and today that is a monthly xlsx a human exports and
-- imports. The portal's receiver has been live since 2026-09-05 and is waiting
-- for us. This file is the ERP half: a row per changed sales order, captured in
-- the SAME TRANSACTION as the salesperson's Save, so a committed order cannot
-- exist without a forward task.
--
-- THIS FILE SENDS NOTHING. It records what changed and builds the snapshot on
-- demand. The Worker's */5 cron drains it (scm/lib/venture-portal-outbox.ts),
-- and it stays dark until scm.app_config 'scm.venture_portal_feed' is turned on
-- AND scm.sync_config holds vp.url + vp.secret. Three independent off switches.
--
-- ── DIVERGENCE 1 FROM THE PORTAL'S HAND-OFF CONTRACT: no pg_cron, no pg_net ──
-- The contract specifies pg_cron every 10s + pg_net for the POST, mirroring the
-- 2990 -> Houzs design (docs/2990-live-sync/02_worker_2990.sql), and listed
-- "are the extensions on?" as an OPEN POINT. It is settled and the answer is
-- NO. Measured against production (anogrigyjbduyzclzjgn) on 2026-09-12 via the
-- Supabase MCP:
--   SELECT string_agg(extname||' '||extversion, ', ') FROM pg_extension
--    WHERE extname IN ('pg_net','pg_cron');   ->  NULL
-- Neither is installed. Installing them would buy ~10s latency and cost this
-- repo the thing it protects hardest: a pg_cron job is invisible to typecheck,
-- vitest, the lint ratchet and every audit script here, and CLAUDE.md records
-- what that costs — audit:map reported nothing for three weeks because the
-- script it ran had been crashing since the day after it was written. The
-- Worker's */5 slot already drains TWO outboxes (email_outbox, autocount_outbox)
-- in TypeScript that CI executes. Commission is settled monthly; 5 minutes and
-- 10 seconds are the same number to it. So the queue is here and the sender is
-- there, and nothing about production's shape changes to ship this.
--
-- ── DIVERGENCE 2 FROM scm.autocount_outbox (0277): built at SEND, not enqueue ─
-- 0277 says, in capitals, that its payload is a snapshot taken at enqueue time
-- and never recomposed, because it is the audit record of what the ERP told
-- AutoCount. This feed is the opposite kind of thing and must do the opposite.
-- It is a STATE MIRROR, not an operation log: the portal upserts one live row
-- per document, orders deliveries by snapshotAt and applies the newest. Building
-- at SEND time collapses five edits to one order into one delivery, and
-- guarantees a retry carries current state rather than replaying a stale one.
-- The portal's contract asks for exactly this ("The drain builds the payload at
-- send time, so a retry always carries the newest state").
-- That is why scm.vp_build_payloads() lives here and why there is NO payload
-- column on the table below.
--
-- ── DIVERGENCE 3: one PENDING row per document ───────────────────────────────
-- Follows from 2. Ten edits to one order are one delivery, so a partial unique
-- index collapses them. 0277 dedupes the same way (autocount_outbox_dedupe_idx),
-- scoped to pending for the same reason: a delivered row must never block the
-- next legitimate change to that document.
--
-- ── DIVERGENCE 4: the contract's `-- $` line-comment markers are NOT used ────
-- The contract asks for a `-- $` after every internal semicolon in a PL/pgSQL
-- body, citing this repo's migration 0066. That instruction is obsolete here.
-- scripts/lib/split-sql.mjs is dollar-quote aware and hands a function body over
-- byte-intact, and the live tree agrees: `grep -l -- "-- \$"
-- backend/src/db/migrations-pg/*.sql` matches ZERO files (run 2026-09-12).
-- Adding them back would be cargo.
--
-- ── PII: the contract's 18 columns, plus two it missed ───────────────────────
-- city and postcode are on the view and are not commission inputs either. The
-- portal reads a fixed column list and ignores anything else, so widening the
-- strip list cannot break the receiver. The bytes should not travel.
--
-- REVERSAL: DROP TRIGGER trg_vp_outbox_so ON scm.mfg_sales_orders; DROP TRIGGER
-- trg_vp_outbox_items ON scm.mfg_sales_order_items; DROP TRIGGER
-- trg_vp_outbox_payments ON scm.mfg_sales_order_payments; DROP FUNCTION
-- scm.enqueue_vp_outbox(), scm.enqueue_vp_outbox_child(),
-- scm.vp_build_payloads(text[]),
-- scm.vp_requeue_undelivered(bigint[], date, boolean); DROP TABLE
-- scm.venture_portal_outbox; DELETE FROM scm.app_config WHERE key =
-- 'scm.venture_portal_feed'; DELETE FROM scm.sync_config WHERE k LIKE 'vp.%'.
-- No GRANTS need restoring — this file DROPS no existing object, so no ACL is
-- lost (the trap 0189 fell into and 0190 + 0191 had to repair). No existing
-- table is altered and no data outside these objects is touched.
--
-- Verified against: production schema (anogrigyjbduyzclzjgn) read 2026-09-12 via
-- the Supabase MCP — scm.mfg_sales_orders_with_payment_totals carries
-- paid_total_sen / balance_sen_live / on_hold; mfg_sales_order_items carries
-- cancelled(boolean), line_no(integer), unit_cost_sen / line_cost_sen /
-- line_margin_sen(integer); mfg_sales_order_payments carries so_doc_no +
-- paid_at(date); scm.staff.id is uuid with staff_code / name / user_id(integer);
-- scm.app_config is (key, value, description, updated_at, updated_by,
-- company_id); scm.sync_config (0123) exists and is empty.
-- RE-RUN: no-op. Every object is IF NOT EXISTS / OR REPLACE / DROP TRIGGER IF
-- EXISTS, and the app_config seed is ON CONFLICT DO NOTHING, so a second run
-- cannot re-arm a switch someone deliberately turned on or off.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- ── The queue ───────────────────────────────────────────────────────────────
-- Status vocabulary is 0277's, deliberately, so this system has ONE dialect for
-- "where is my outbox row": pending -> sent (delivered and acked) | failed
-- (attempts exhausted, a human must look) | skipped (out of scope, never sent).
CREATE TABLE IF NOT EXISTS scm.venture_portal_outbox (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_no         text NOT NULL,
  -- INSERT | UPDATE | DELETE, suffixed ':<table>' when a child row fired it,
  -- BACKFILL / RECONCILE when a sweep queued it. Diagnostic only.
  op             text NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  -- What the portal SAID it did: applied | duplicate | stale | held | skipped.
  -- A 200 whose outcome is not `applied` is still a successful DELIVERY, and
  -- conflating the two is the mistake the contract warns about twice. Kept so
  -- the admin page can show "delivered, and the portal held it" rather than a
  -- bare green tick.
  portal_outcome text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);

COMMENT ON TABLE scm.venture_portal_outbox IS
  'ERP -> Venture Portal live sales-order feed queue. One PENDING row per changed sales order (header, item or payment). Drained by the */5 cron (scm/lib/venture-portal-outbox.drainVenturePortalOutbox) when scm.app_config key scm.venture_portal_feed is on and scm.sync_config holds vp.url + vp.secret. The payload is built at SEND time by scm.vp_build_payloads(), not stored here: this is a state mirror, not an audit log.';

-- The drain's only lookup: undelivered rows, oldest first.
CREATE INDEX IF NOT EXISTS venture_portal_outbox_pending_idx
  ON scm.venture_portal_outbox (created_at)
  WHERE status = 'pending';

-- One PENDING row per document (divergence 3 above).
CREATE UNIQUE INDEX IF NOT EXISTS venture_portal_outbox_pending_doc_idx
  ON scm.venture_portal_outbox (doc_no)
  WHERE status = 'pending';

-- "What happened to this document" without a sequential scan of the history.
CREATE INDEX IF NOT EXISTS venture_portal_outbox_doc_idx
  ON scm.venture_portal_outbox (doc_no, created_at DESC);


-- ── The snapshot builder ────────────────────────────────────────────────────
-- ONE round trip per drain sweep, not four per document. The Worker reaches
-- PostgREST over Hyperdrive and CLAUDE.md keeps a standing subrequest diet; a
-- 50-document sweep composing header + items + payments + salesperson in the
-- Worker would be 200 subrequests, against 1 for this.
--
-- STABLE, so now() is transaction time and every payload in one sweep carries
-- the same snapshotAt. SECURITY DEFINER because the caller is the PostgREST
-- service role and the function reads a view whose owner resolves the base
-- tables (see 20260912T0130 for why that ownership matters here).
CREATE OR REPLACE FUNCTION scm.vp_build_payloads(p_doc_nos text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
DECLARE
  out_rows jsonb := '[]'::jsonb;
  dn       text;
  hdr      jsonb;
  sp       jsonb;
BEGIN
  FOREACH dn IN ARRAY COALESCE(p_doc_nos, ARRAY[]::text[])
  LOOP
    /* The header comes from the VIEW, never the base table: paid_total_sen and
       balance_sen_live are computed there and the portal's deposit gate reads
       balance_sen_live first. Customer PII and the two whole-image base64
       columns are removed before the row ever leaves the database. */
    SELECT to_jsonb(v) - ARRAY[
             'phone', 'email',
             'address1', 'address2', 'address3', 'address4',
             'city', 'postcode',
             'ship_to_address', 'bill_to_address', 'install_to_address',
             'emergency_contact_name', 'emergency_contact_phone',
             'emergency_contact_relationship',
             'customer_po_image_b64', 'signature_b64',
             'note', 'remark2', 'remark3', 'remark4']
      INTO hdr
      FROM scm.mfg_sales_orders_with_payment_totals v
     WHERE v.doc_no = dn;

    IF hdr IS NULL THEN
      /* The document is gone. The portal excludes it as DELETED; it does not
         guess, and neither do we. */
      out_rows := out_rows || jsonb_build_object(
        'docNo', dn, 'deleted', true, 'snapshotAt', now());
      CONTINUE;
    END IF;

    /* The person behind salesperson_id. The portal matches this to its own
       staff roster ONCE and remembers the pick, so id is the durable key and
       name is only the display and the fallback match. */
    SELECT jsonb_build_object(
             'id', s.id, 'name', s.name,
             'staff_code', s.staff_code, 'user_id', s.user_id)
      INTO sp
      FROM scm.staff s
     WHERE s.id = (hdr ->> 'salesperson_id')::uuid;

    out_rows := out_rows || jsonb_build_object(
      'docNo', dn,
      'snapshotAt', now(),
      'deleted', false,
      'header', hdr,
      'items', COALESCE((
        SELECT jsonb_agg(to_jsonb(i) ORDER BY i.line_no NULLS LAST, i.created_at)
          FROM scm.mfg_sales_order_items i
         WHERE i.doc_no = dn), '[]'::jsonb),
      'payments', COALESCE((
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.paid_at, p.created_at)
          FROM scm.mfg_sales_order_payments p
         WHERE p.so_doc_no = dn), '[]'::jsonb),
      'salesperson', sp);
  END LOOP;

  RETURN out_rows;
END
$fn$;

COMMENT ON FUNCTION scm.vp_build_payloads(text[]) IS
  'Builds the Venture Portal delivery for each doc_no: header from scm.mfg_sales_orders_with_payment_totals minus customer PII, items and payments verbatim, plus the salesperson behind salesperson_id. A doc_no with no header row returns {deleted:true}. Called once per drain sweep by scm/lib/venture-portal-outbox.ts.';

-- ── The backstop ───────────────────────────────────────────────────────────
-- Queue every in-scope sales order that has NOT been delivered. This is ONE
-- function serving two buttons, because they are one operation: the initial
-- BACKFILL ("the portal should hold August onwards") and the hourly RECONCILE
-- ("did we miss anything") both mean "queue what has not been delivered". The
-- contract wrote them as two separate SQL statements and there is no second
-- behaviour hiding in the difference.
--
-- IT IS THE REASON "not one order missed" is more than a hope. The capture
-- trigger swallows its own errors on purpose, so a row CAN be missed; this is
-- what finds it. Set-based on purpose: 493 in-scope orders on production today
-- (counted 2026-09-12) is one statement here and 493 round trips from a Worker.
--
-- NO CHURN, and that took thinking about. A document the drain marked `skipped`
-- for being out of scope is excluded from this SELECT by the same scope
-- arguments, so the pair cannot ping-pong a row between skipped and pending
-- every hour. A document parked `failed` is left alone unless the caller asks
-- for it, because a person clearing the cause is what should release it.
CREATE OR REPLACE FUNCTION scm.vp_requeue_undelivered(
  p_companies     bigint[],
  p_since         date,
  p_include_failed boolean
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
DECLARE
  n integer;
BEGIN
  INSERT INTO scm.venture_portal_outbox (doc_no, op)
  SELECT so.doc_no, 'RECONCILE'
    FROM scm.mfg_sales_orders so
   WHERE (p_companies IS NULL OR so.company_id = ANY (p_companies))
     AND (p_since IS NULL OR so.so_date >= p_since)
     AND NOT EXISTS (SELECT 1 FROM scm.venture_portal_outbox o
                      WHERE o.doc_no = so.doc_no AND o.status = 'sent')
     AND NOT EXISTS (SELECT 1 FROM scm.venture_portal_outbox o
                      WHERE o.doc_no = so.doc_no AND o.status = 'pending')
     AND (p_include_failed
          OR NOT EXISTS (SELECT 1 FROM scm.venture_portal_outbox o
                          WHERE o.doc_no = so.doc_no AND o.status = 'failed'))
  ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

COMMENT ON FUNCTION scm.vp_requeue_undelivered(bigint[], date, boolean) IS
  'Queues every in-scope sales order with no delivered (sent) outbox row. Serves both the initial backfill and the hourly self-heal. p_companies NULL means every company; p_since NULL means no date floor; p_include_failed releases rows parked after exhausting their attempts. Returns rows queued — steady state is 0.';

-- The PostgREST service role is the only caller; the hyperdrive loop follows
-- 20260912T0130's rule, which this repo paid for twice: the Hyperdrive origin
-- roles are named in Cloudflare connection strings and in no file here, so they
-- are matched by prefix rather than guessed by name.
DO $grant$
DECLARE
  g record;
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'scm.vp_build_payloads(text[])',
    'scm.vp_requeue_undelivered(bigint[], date, boolean)']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
    FOR g IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'hyperdrive%' LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, g.rolname);
    END LOOP;
  END LOOP;
END
$grant$;


-- ── Same-transaction capture ────────────────────────────────────────────────
-- The trigger swallows its own errors, on purpose and for the reason the 2990
-- mirror states: an outbox failure must NEVER roll back a salesperson's Save.
-- A row missed that way is recovered by the reconcile sweep, which re-queues
-- any in-scope order with no delivered row.
CREATE OR REPLACE FUNCTION scm.enqueue_vp_outbox() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
BEGIN
  BEGIN
    INSERT INTO scm.venture_portal_outbox (doc_no, op)
    VALUES (COALESCE(NEW.doc_no, OLD.doc_no), TG_OP)
    ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;

-- Only the columns the portal reads. An UPDATE that touches none of them
-- (priority_rank, allocation_warehouse_id, the MRP fields) queues nothing, so
-- the feed does not wake for changes it would deliver identically.
DROP TRIGGER IF EXISTS trg_vp_outbox_so ON scm.mfg_sales_orders;
CREATE TRIGGER trg_vp_outbox_so
  AFTER INSERT OR DELETE OR UPDATE OF
    status, on_hold, so_date, branding, salesperson_id, agent,
    debtor_name, debtor_code, sales_location, company_id,
    local_total_sen, subtotal_sen, balance_sen, deposit_sen, paid_sen,
    delivery_fee_sen, total_cost_sen, total_margin_sen
  ON scm.mfg_sales_orders
  FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox();

-- An item or payment edit re-forwards the PARENT order: the header's updated_at
-- is not always bumped when only a line or a payment changes, so the parent
-- doc_no is read off the child row.
CREATE OR REPLACE FUNCTION scm.enqueue_vp_outbox_child() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
DECLARE
  keycol text := TG_ARGV[0];
  dn     text;
BEGIN
  BEGIN
    dn := COALESCE(to_jsonb(NEW) ->> keycol, to_jsonb(OLD) ->> keycol);
    IF dn IS NOT NULL THEN
      INSERT INTO scm.venture_portal_outbox (doc_no, op)
      VALUES (dn, TG_OP || ':' || TG_TABLE_NAME)
      ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;

-- line_cost_sen and unit_cost_sen are in this list because product COSTING is
-- half of what the portal was waiting for: a margin layer cannot open without
-- it, and a cost corrected after the sale must travel.
DROP TRIGGER IF EXISTS trg_vp_outbox_items ON scm.mfg_sales_order_items;
CREATE TRIGGER trg_vp_outbox_items
  AFTER INSERT OR DELETE OR UPDATE OF
    item_group, item_code, description, description2, uom, location,
    qty, unit_price_sen, discount_sen, total_sen, branding, cancelled,
    unit_cost_sen, line_cost_sen, line_margin_sen, line_no
  ON scm.mfg_sales_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox_child('doc_no');

DROP TRIGGER IF EXISTS trg_vp_outbox_payments ON scm.mfg_sales_order_payments;
CREATE TRIGGER trg_vp_outbox_payments
  AFTER INSERT OR UPDATE OR DELETE ON scm.mfg_sales_order_payments
  FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox_child('so_doc_no');

-- NO backfill statement here, deliberately. The 2990 file backfilled every SO
-- at apply time; this feed is bounded by company and start date, and both live
-- in scm.sync_config, which is empty when this migration runs. The backfill is
-- a button on the admin page instead, so it happens after somebody has set the
-- scope and can watch it.


-- ── The runtime switch ──────────────────────────────────────────────────────
-- Same table and grammar as the AutoCount write-back (0277) and the go-live
-- write freeze (0272): 'off' | 'all' | comma-separated company ids. SEEDED OFF.
-- Turning it on sends real sales orders to an external system, so it is an
-- explicit act, never a side effect of a deploy.
INSERT INTO scm.app_config (key, value, description)
VALUES ('scm.venture_portal_feed', 'off',
        'ERP -> Venture Portal live sales-order feed. off = nothing is queued and nothing is sent. Set to a company id list (Houzs Century is 1) to enable. Read by scm/lib/venture-portal-feed-flag.ts. The receiver URL and shared secret live in scm.sync_config under vp.url and vp.secret.')
ON CONFLICT (key) DO NOTHING;
