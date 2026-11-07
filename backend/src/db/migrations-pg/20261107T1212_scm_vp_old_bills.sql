-- ----------------------------------------------------------------------------
-- 20261107T1212 -- the Venture Portal hears a departed salesperson's OLD order
-- once money reaches it again.
--
-- WHY. The feed never sends an order dated before vp.since (2026-08-01), so
-- years of history cannot leak into anybody's commission. The portal now pays
-- one case of that history (owner, 2026-11-07): an order whose salesperson has
-- left, that was under its deposit when the portal started paying (so no
-- commission ever went out on it), topped up since by a colleague -- the
-- colleague who COLLECTED the top-up earns it. HC-SO-010734 (paper ZNT4813,
-- sold 2026-03-10 by a salesperson who has since left, RM 6,000, RM 800
-- deposit) took RM 3,200 from a colleague on 2026-11-02 and the portal never
-- heard: every one of that day's deliveries was skipped here as "dated before
-- vp.since". The portal decides who earns what; this side only has to send
-- the order and say who collected each payment.
--
-- WHAT CHANGES.
--   1. scm.vp_old_orders_wanted(text[], date) -- of the given documents, the
--      ones dated before the date whose salesperson's scm.staff row is not
--      active and which have a payment dated on or after it. The drain asks it
--      about every row it would skip as too old, and sends those it names
--      (scm/lib/venture-portal-outbox.ts). Everything else before vp.since is
--      skipped without a request, as before.
--   2. vp_build_payloads: 20260927T2100's definition with two keys added --
--      `active` on the salesperson (who has left), and `collected_by_name` on
--      every payment row (the colleague the portal pays). Rows otherwise
--      verbatim.
--   3. vp_requeue_undelivered: 20260912T1800's definition with one statement
--      added -- it also queues each such old order (company scope as before;
--      no pending row; a failed one only when asked) whose newest change was
--      not delivered, or whose newest payment dated on or after p_since was
--      recorded after its last delivery. All 84 such orders today had a sent
--      row from the first backfill (2026-09-13/14) and a skipped row after it,
--      so the half-hourly reconcile delivers each once after this ships. 4 of
--      the 10 that crossed their deposit since 2026-09-01 took the top-up
--      before that backfill sent them, which is why "sent after the newest
--      payment" alone is not enough.
--
-- WHAT THE PORTAL DOES WITH IT. Its receiver (Venture Portal migration
-- *_old_bills_topped_up, branch feat/old-bill-top-up) keeps such an order only
-- when salesperson.active is false, it was under the deposit threshold when the
-- portal started paying (2026-09-01) and a payment since took it over; the bill
-- lands in a month still open, on the collector's ledger, and anything else is
-- answered 200 skipped. DEPLOY THE PORTAL FIRST: today's receiver answers
-- skipped, the row is marked sent, and nothing would queue it again until the
-- order is saved.
--
-- REVERSAL: deploy the drain without its vp_old_orders_wanted call FIRST (with
--   the function gone, the call fails and every sweep holding an old row
--   aborts); then re-run the CREATE OR REPLACE FUNCTION scm.vp_build_payloads
--   block of 20260927T2100 verbatim, re-run the CREATE OR REPLACE FUNCTION
--   scm.vp_requeue_undelivered block of 20260912T1800 verbatim (CREATE OR
--   REPLACE keeps both functions' grants), and DROP FUNCTION IF EXISTS
--   scm.vp_old_orders_wanted(text[], date). No table, column, view or grant of
--   anything else is touched. Rows already queued stay; the portal answers them.
-- Verified against: production (anogrigyjbduyzclzjgn), read-only, 2026-11-07.
--   md5(prosrc) of scm.vp_build_payloads(text[]) is
--   c4f8ed2dfc2d2c99a8ed76f7923f7e95 and of scm.vp_requeue_undelivered(bigint[],
--   date, boolean) b75de92eeefb1c79919a1a763b9e0cdc -- the bodies of
--   20260927T2100 and 20260912T1800 exactly (LF line ends); both SECURITY
--   DEFINER, search_path scm, public. scm.staff.active is boolean NOT NULL,
--   mfg_sales_order_payments.collected_by is uuid (every non-null one is a
--   scm.staff id). Company 1: 2,451 orders before 2026-08-01; 84 of them have a
--   departed salesperson and money dated on or after 2026-08-01 (the rule in 1);
--   no scm.vp_old_orders_wanted existed.
-- RE-RUN: CREATE OR REPLACE throughout; the grants are idempotent.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- -- 1. Which old orders are wanted ------------------------------------------
-- A set-based answer for the whole sweep, so the drain spends one round trip
-- on it, not one per row.
CREATE OR REPLACE FUNCTION scm.vp_old_orders_wanted(p_doc_nos text[], p_since date)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
  SELECT COALESCE(array_agg(so.doc_no ORDER BY so.doc_no), ARRAY[]::text[])
    FROM scm.mfg_sales_orders so
    JOIN scm.staff st ON st.id = so.salesperson_id
   WHERE p_since IS NOT NULL
     AND so.doc_no = ANY (COALESCE(p_doc_nos, ARRAY[]::text[]))
     AND so.so_date < p_since
     AND st.active = false
     AND EXISTS (SELECT 1 FROM scm.mfg_sales_order_payments p
                  WHERE p.so_doc_no = so.doc_no AND p.paid_at >= p_since)
$fn$;

COMMENT ON FUNCTION scm.vp_old_orders_wanted(text[], date) IS
  'Of p_doc_nos, the orders the Venture Portal feed sends although they are dated before p_since (vp.since): their salesperson''s scm.staff row is not active, and a payment dated on or after p_since reached them. The portal pays whoever collected the top-up of a departed salesperson''s order that was under its deposit when the portal started paying. Empty for a NULL p_since or no documents. Called once per drain sweep by scm/lib/venture-portal-outbox.ts and by scm.vp_requeue_undelivered.';

-- -- 2. The order feed: who has left, and who collected each payment ---------
-- 20260927T2100's definition with TWO keys added: the salesperson's 'active',
-- and each payment's 'collected_by_name'.
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
       name is only the display and the fallback match. `active` says whether
       they still work here (20261107T1212): the portal pays a departed
       salesperson's old order to whoever collected its top-up. */
    SELECT jsonb_build_object(
             'id', s.id, 'name', s.name,
             'staff_code', s.staff_code, 'user_id', s.user_id,
             'active', s.active)
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
      /* Each payment's row verbatim, plus the name of the person who collected
         it (20261107T1212) -- null when nobody is recorded. */
      'payments', COALESCE((
        SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('collected_by_name', cb.name)
                         ORDER BY p.paid_at, p.created_at)
          FROM scm.mfg_sales_order_payments p
          LEFT JOIN scm.staff cb ON cb.id = p.collected_by
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
         WHERE so.doc_no = dn),
      /* Which brand the bill is FOR when its products name none (20260927T2100):
         the salesperson's answer to the order form's question, for the portal
         only -- `branding` in the header is untouched by it. Read from the
         BASE table like `fair`. NULL when never asked, or skipped. */
      'vpBrand', (
        SELECT so.vp_brand
          FROM scm.mfg_sales_orders so
         WHERE so.doc_no = dn));
  END LOOP;

  RETURN out_rows;
END
$fn$;

COMMENT ON FUNCTION scm.vp_build_payloads(text[]) IS
  'Builds the Venture Portal delivery for each doc_no: header from scm.mfg_sales_orders_with_payment_totals minus customer PII, payments verbatim plus collected_by_name (the scm.staff name of collected_by; null when none), items verbatim except variants (cut to fabricCode / seatHeight / legHeight / divanHeight / gap / totalHeight / size / specials, omitted when none), the salesperson behind salesperson_id (id, name, staff_code, user_id, active), the fair the order was written at (fair: the picked project''s id, code, name, venue, organizer, brand, start/end date, status, event type, plus the order''s fair_match and fair_date; null when the order has no project), and vpBrand: the brand a person said the bill is for when its products name none (mfg_sales_orders.vp_brand; null when never asked or skipped). A doc_no with no header row returns {deleted:true}. Called once per drain sweep by scm/lib/venture-portal-outbox.ts.';

-- -- 3. The backstop also finds the wanted old orders ------------------------
-- 20260912T1800's definition with ONE statement added after the first.
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
  m integer;
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

  /* An order dated before p_since that the drain sends anyway
     (scm.vp_old_orders_wanted, 20261107T1212). "Has a sent row" cannot be the
     test here: the first backfill delivered these before the portal had a
     date floor, and every save since was skipped. So it is queued when its
     newest change was not delivered, or when money dated on or after p_since
     was recorded after its last delivery. A row the drain then sends is the
     newest, so the next sweep finds nothing to do. */
  IF p_since IS NOT NULL THEN
    INSERT INTO scm.venture_portal_outbox (doc_no, op)
    SELECT so.doc_no, 'RECONCILE'
      FROM scm.mfg_sales_orders so
     WHERE so.doc_no = ANY (scm.vp_old_orders_wanted(ARRAY(
             SELECT o.doc_no FROM scm.mfg_sales_orders o
              WHERE o.so_date < p_since
                AND (p_companies IS NULL OR o.company_id = ANY (p_companies))), p_since))
       AND NOT EXISTS (SELECT 1 FROM scm.venture_portal_outbox o
                        WHERE o.doc_no = so.doc_no AND o.status = 'pending')
       AND (p_include_failed
            OR NOT EXISTS (SELECT 1 FROM scm.venture_portal_outbox o
                            WHERE o.doc_no = so.doc_no AND o.status = 'failed'))
       AND (COALESCE((SELECT max(o.created_at) FROM scm.venture_portal_outbox o
                       WHERE o.doc_no = so.doc_no AND o.status = 'sent'), '-infinity'::timestamptz)
              < (SELECT max(o.created_at) FROM scm.venture_portal_outbox o
                  WHERE o.doc_no = so.doc_no)
            OR COALESCE((SELECT max(o.sent_at) FROM scm.venture_portal_outbox o
                          WHERE o.doc_no = so.doc_no AND o.status = 'sent'), '-infinity'::timestamptz)
              < (SELECT max(p.created_at) FROM scm.mfg_sales_order_payments p
                  WHERE p.so_doc_no = so.doc_no AND p.paid_at >= p_since))
    ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;

    GET DIAGNOSTICS m = ROW_COUNT;
    n := n + m;
  END IF;

  RETURN n;
END
$fn$;

COMMENT ON FUNCTION scm.vp_requeue_undelivered(bigint[], date, boolean) IS
  'Queues every in-scope sales order with no delivered (sent) outbox row, and every order dated before p_since that scm.vp_old_orders_wanted names whose newest change was not delivered or whose newest payment dated on or after p_since was recorded after its last delivery. Serves both the initial backfill and the half-hourly self-heal. p_companies NULL means every company; p_since NULL means no date floor (and no old orders to look for); p_include_failed releases rows parked after exhausting their attempts. Returns rows queued — steady state is 0.';

-- -- Grants ------------------------------------------------------------------
-- The PostgREST service role is the only caller of the new function (the drain,
-- and the requeue as its owner). Hyperdrive origin roles are matched by prefix,
-- as 20261012T1400 does, because their names live in Cloudflare connection
-- strings and in no file here. The two replaced functions keep their grants.
DO $grant$
DECLARE
  g record;
BEGIN
  REVOKE ALL ON FUNCTION scm.vp_old_orders_wanted(text[], date) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION scm.vp_old_orders_wanted(text[], date) TO service_role;
  END IF;
  FOR g IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'hyperdrive%' LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION scm.vp_old_orders_wanted(text[], date) TO %I', g.rolname);
  END LOOP;
END
$grant$;
