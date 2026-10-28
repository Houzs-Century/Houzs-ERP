-- ----------------------------------------------------------------------------
-- 20260927T0100 — the Venture Portal feed carries the FAIR an order was
-- written at.
--
-- WHY. The portal pays Revenue commission by month, and which month a bill is
-- paid in is decided by the fair it was written at — not by so_date, the day
-- it was keyed (median +4 days after the sale, worst +42, measured by the
-- portal on August 2026). Until now the portal GUESSED the fair from the
-- header's venue text and so_date, against a fair calendar somebody typed by
-- hand on its side. This system has known the answer since the fair picker
-- (owner, 2026-09-13): project_id names the brand booth of the picked event,
-- fair_date (2026-09-24) the day of the sale, and from 2026-09-27 the pick is
-- required to open an order. None of it reached the portal:
--
--   * vp_build_payloads takes the header from the VIEW
--     mfg_sales_orders_with_payment_totals, whose column list was frozen when
--     it was created — before project_id / fair_match / fair_date existed —
--     so the three columns are not in any delivery. Measured on the portal
--     2026-09-27: raw.header of the newest deliveries (HC-SO-2609-219..221)
--     has no project_id key, while this database has project 347 / 2212 on
--     them.
--   * trg_vp_outbox_so fires on a fixed column list that has no project_id,
--     fair_match, fair_date, venue or venue_id — so re-picking the event on a
--     saved order queued nothing at all.
--
-- WHAT CHANGES.
--   1. vp_build_payloads: 20260923T1843's definition with ONE key added to
--      each delivery, 'fair' — the picked project's id, code, name, venue,
--      organizer, brand, start/end date (text, YYYY-MM-DD), status and event
--      type slug, plus the order's own fair_match and fair_date. NULL when
--      the order has no project. Built from the BASE table joined to
--      public.projects, so the view (and the list's header column set, which
--      20260924T1600 deliberately left alone) is untouched. No money, no PII:
--      every key is named.
--   2. trg_vp_outbox_so: the same trigger, its UPDATE OF list plus
--      project_id, fair_match, fair_date, venue, venue_id.
--   3. trg_vp_outbox_project on public.projects: a booth whose venue,
--      organizer, dates or status change re-queues every order that points
--      at it — the portal's fair follows the ERP's without waiting for
--      somebody to save a bill. Same swallow-and-continue rule as
--      enqueue_vp_outbox: a project save never fails because of the feed.
--   4. A one-time requeue of every order with a project dated from
--      2026-09-01 (the portal's first paying month; its August is closed and
--      would only hold them), so those already delivered carry their fair once.
--      The drain's own scope (app_config scm.venture_portal_feed, vp.since)
--      still decides what is sent; out-of-scope rows end 'skipped' as ever.
--
-- WHAT THE PORTAL DOES WITH IT. Its receiver (Venture Portal migration
-- 20260927010000_the_erp_names_the_fair) keeps the event as its fair — one
-- per event, the brand booths folded together — takes this system's
-- organiser and days over anything typed there, and pins the fair to the
-- bill. Deploy the portal first: a portal that does not know `fair` answers
-- 200 and ignores it, so the order is harmless, but the requeue in (4) is
-- only worth anything once the portal reads the key.
--
-- REVERSAL: re-run the CREATE OR REPLACE FUNCTION scm.vp_build_payloads block
--   of 20260923T1843 verbatim (drops the 'fair' key); DROP TRIGGER IF EXISTS
--   trg_vp_outbox_project ON public.projects; DROP FUNCTION IF EXISTS
--   scm.enqueue_vp_outbox_project(); re-create trg_vp_outbox_so with the
--   UPDATE OF list of 20260912T1800 (the list below minus project_id,
--   fair_match, fair_date, venue, venue_id). The requeued outbox rows need no
--   reversal: a delivery is a state mirror, and a re-send of an unchanged
--   order is a no-op on the portal ('duplicate' or 'applied' with no change).
--   No grant is lost: CREATE OR REPLACE keeps vp_build_payloads' ACL.
-- Verified against: production (anogrigyjbduyzclzjgn), read-only via the
--   Supabase MCP on 2026-09-27. scm.mfg_sales_orders has project_id
--   (integer), venue_source, fair_match, fair_date (date), venue, venue_id;
--   public.projects has id (bigint), code, name, venue, organizer, brand,
--   start_date / end_date (text, YYYY-MM-DD), status, event_type_id;
--   public.project_event_types has slug. vp_build_payloads was read with
--   pg_get_functiondef and matches 20260923T1843 exactly; trg_vp_outbox_so
--   was read with pg_get_triggerdef. Houzs Century orders with a project:
--   Jul 0 / 311, Aug 14 / 319, Sep 150 / 327 (so_date months); every order
--   created 2026-09-23..26 had one.
-- RE-RUN: CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout; a second run
--   of (4) queues the same orders again, which is harmless (see REVERSAL).
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- ── 1. The order feed: each delivery names its fair ─────────────────────────
-- 20260923T1843's definition with ONE key added: 'fair'.
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
             'note', 'remark2', 'remark3', 'remark4',
             /* The PAYMENT ARTEFACTS, added after reading what the payload
                actually carries rather than what the contract remembered to
                name. `approval_code` is a card/terminal authorisation code and
                the other three are pointers to payment-slip and receipt IMAGES
                — customer bank documents. None is a commission input, the
                portal's own field list (contract §3) reads none of them, and
                the portal answers 200 for anything it can still read, so
                removing them cannot break the receiver. Minimum privilege is
                the default here (CLAUDE.md rule 5), and this file becomes
                immutable the moment it is applied. */
             'approval_code', 'slip_key', 'slip_image_key', 'receipt_image_key']
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
        SELECT jsonb_agg(
                 /* Every column as before except `variants`, which is cut to
                    the option keys the portal parses a line by. Anything else
                    in it (extraAddonAmountRM, remark, extraAddonNote, ...) is
                    money or free text and stays here; an allowlisted key whose
                    value is an object is dropped, and an array keeps only its
                    strings, so nothing can hide inside one. */
                 (to_jsonb(i) - 'variants')
                 || COALESCE((
                      SELECT jsonb_build_object('variants', jsonb_object_agg(k.key,
                               CASE WHEN jsonb_typeof(i.variants -> k.key) = 'array'
                                    THEN jsonb_path_query_array(i.variants -> k.key, '$[*] ? (@.type() == "string")')
                                    ELSE i.variants -> k.key
                               END))
                        FROM unnest(ARRAY['fabricCode', 'seatHeight', 'legHeight', 'divanHeight',
                                          'gap', 'totalHeight', 'size', 'specials']) AS k(key)
                       WHERE jsonb_typeof(i.variants) = 'object'
                         AND jsonb_typeof(i.variants -> k.key) IN ('string', 'number', 'null', 'array')
                      HAVING count(*) > 0), '{}'::jsonb)
                 ORDER BY i.line_no NULLS LAST, i.created_at)
          FROM scm.mfg_sales_order_items i
         WHERE i.doc_no = dn), '[]'::jsonb),
      'payments', COALESCE((
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.paid_at, p.created_at)
          FROM scm.mfg_sales_order_payments p
         WHERE p.so_doc_no = dn), '[]'::jsonb),
      'salesperson', sp,
      /* The fair the salesperson picked (the fair picker, 2026-09-13): the
         brand booth's project, and the order's own verdict and day. Named
         keys only, so a project column added later cannot ride along. Read
         from the BASE table: the header view's column list predates
         project_id. NULL when the order has no project. */
      'fair', (
        SELECT jsonb_build_object(
                 'projectId', p.id,
                 'code', p.code,
                 'name', p.name,
                 'venue', p.venue,
                 'organizer', p.organizer,
                 'brand', p.brand,
                 'startDate', p.start_date,
                 'endDate', p.end_date,
                 'status', p.status,
                 'eventType', et.slug,
                 'match', so.fair_match,
                 'fairDate', so.fair_date)
          FROM scm.mfg_sales_orders so
          JOIN public.projects p ON p.id = so.project_id
          LEFT JOIN public.project_event_types et ON et.id = p.event_type_id
         WHERE so.doc_no = dn));
  END LOOP;

  RETURN out_rows;
END
$fn$;

COMMENT ON FUNCTION scm.vp_build_payloads(text[]) IS
  'Builds the Venture Portal delivery for each doc_no: header from scm.mfg_sales_orders_with_payment_totals minus customer PII, payments verbatim, items verbatim except variants (cut to fabricCode / seatHeight / legHeight / divanHeight / gap / totalHeight / size / specials, omitted when none), the salesperson behind salesperson_id, and the fair the order was written at (fair: the picked project''s id, code, name, venue, organizer, brand, start/end date, status, event type, plus the order''s fair_match and fair_date; null when the order has no project). A doc_no with no header row returns {deleted:true}. Called once per drain sweep by scm/lib/venture-portal-outbox.ts.';

-- ── 2. Re-picking the event is a change the portal must hear ────────────────
-- 20260912T1800's trigger, its UPDATE OF list as production has it plus the
-- five columns that say where the order was written.
DROP TRIGGER IF EXISTS trg_vp_outbox_so ON scm.mfg_sales_orders;
CREATE TRIGGER trg_vp_outbox_so
  AFTER INSERT OR DELETE OR UPDATE OF
    status, on_hold, so_date, branding, salesperson_id, agent,
    debtor_name, debtor_code, sales_location, company_id,
    local_total_sen, subtotal_sen, balance_sen, deposit_sen, paid_sen,
    delivery_fee_sen, total_cost_sen, total_margin_sen,
    project_id, fair_match, fair_date, venue, venue_id
  ON scm.mfg_sales_orders
  FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox();

-- ── 3. A booth that changes re-queues its orders ────────────────────────────
-- The portal's fair takes this system's venue, organizer and days, so a
-- correction here must reach it without waiting for somebody to save a bill.
-- Swallows its own errors exactly as enqueue_vp_outbox does: a project save
-- never fails because of the feed.
CREATE OR REPLACE FUNCTION scm.enqueue_vp_outbox_project()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
BEGIN
  BEGIN
    INSERT INTO scm.venture_portal_outbox (doc_no, op)
    SELECT so.doc_no, 'UPDATE:projects'
      FROM scm.mfg_sales_orders so
     WHERE so.project_id = NEW.id
    ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_vp_outbox_project ON public.projects;
CREATE TRIGGER trg_vp_outbox_project
  AFTER UPDATE OF venue, organizer, start_date, end_date, status ON public.projects
  FOR EACH ROW
  WHEN (OLD.venue IS DISTINCT FROM NEW.venue
        OR OLD.organizer IS DISTINCT FROM NEW.organizer
        OR OLD.start_date IS DISTINCT FROM NEW.start_date
        OR OLD.end_date IS DISTINCT FROM NEW.end_date
        OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION scm.enqueue_vp_outbox_project();

-- ── 4. The orders already delivered carry their fair once ───────────────────
-- Every order with a project from September 2026, the first month the portal
-- pays (its August was settled by hand and is closed to the feed: a re-send
-- there is only held). The drain's scope decides what is actually sent.
INSERT INTO scm.venture_portal_outbox (doc_no, op)
SELECT so.doc_no, 'BACKFILL:fair'
  FROM scm.mfg_sales_orders so
 WHERE so.project_id IS NOT NULL
   AND so.so_date >= DATE '2026-09-01'
ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
