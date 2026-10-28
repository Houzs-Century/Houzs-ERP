-- ----------------------------------------------------------------------------
-- 20260927T2100 -- a sales order can say which BRAND it is for, for the
-- Venture Portal only.
--
-- WHY. The portal pays Revenue commission on a margin ladder, and the ladder is
-- the bill's brand -- which it reads from `branding`. That column is worked out
-- from the products (derive-line-branding.ts), so a bill of bed frames or
-- accessories alone is BEDFRAME, SERVICE, NONE or blank: a kind of goods, not a
-- brand. Those bills are never sold on their own (owner 2026-09-27): a bed frame
-- or a pillow is a SECOND bill written at a brand's fair, and it follows that
-- fair's brand -- "the fair is Akemi, it follows the Akemi margin ladder". The
-- fair picker names the brand only when it linked a booth, and a bed-frame bill
-- rarely links one: booth matching runs on `branding`, BEDFRAME has no booth,
-- and a bill keyed after the fair closed is UNMATCHED anyway. Ten September
-- bills reached the portal with no brand; two had a linked booth.
--
-- WHAT CHANGES.
--   1. scm.mfg_sales_orders.vp_brand (text, NULL) -- the brand a person said the
--      bill is for. The order form asks after a save when NOTHING on the bill
--      names a brand -- not its branding, not one of its lines (owner) --
--      offering the brands the portal has a margin ladder for, pre-set to the
--      linked booth's brand. Skipping is allowed (some bills need none).
--      Written only by PUT /mfg-sales-orders/:docNo/vp-brand. NOTHING in this
--      system reads it: `branding`, booth matching, AutoCount and the
--      letterhead are exactly as before (owner: leave the ERP's own setting).
--   2. scm.sync_config 'vp.brands' -- which brands the question offers: the
--      portal's margin ladders (owner: "just follow VP"), seeded AKEMI,
--      DUNLOPILLO, ERGOTEX, ZANOTTI when missing. It sits beside the feed's
--      vp.url / vp.secret / vp.since, so following a new ladder on the portal
--      is a one-row UPDATE, not a deploy. Cut to this company's project_brands.
--   3. vp_build_payloads: 20260927T0100's definition with ONE key added to each
--      delivery, 'vpBrand' -- the column's value, from the BASE table like
--      'fair' (the header view's column list is frozen and stays untouched).
--   4. trg_vp_outbox_so: 20260927T0100's UPDATE OF list plus vp_brand, so an
--      answer given after the save reaches the portal.
--
-- WHAT THE PORTAL DOES WITH IT. Its receiver (Venture Portal migration
-- 20260927080000_the_bill_says_its_brand) takes the bill's brand from
-- `branding` when that names a brand, else from 'vpBrand', else from the
-- picked booth's brand, and only then from the lines. Deploy the portal first:
-- a portal that does not know the key answers 200 and ignores it.
--
-- REVERSAL: re-run the CREATE OR REPLACE FUNCTION scm.vp_build_payloads block
--   of 20260927T0100 verbatim (drops the 'vpBrand' key; CREATE OR REPLACE keeps
--   the function's grants); re-create trg_vp_outbox_so with 20260927T0100's
--   UPDATE OF list (this one minus vp_brand); DELETE FROM scm.sync_config
--   WHERE k = 'vp.brands' (nothing is asked without it); then, only if the
--   answers are no longer wanted, ALTER TABLE scm.mfg_sales_orders DROP COLUMN
--   IF EXISTS vp_brand (the CHECK goes with it). No view is dropped or
--   recreated, so no grant is lost anywhere.
-- Verified against: production (anogrigyjbduyzclzjgn), read-only via the
--   Supabase MCP on 2026-09-27. vp_build_payloads' source matches
--   20260927T0100 exactly (md5 of prosrc 25219f68f833c8c133e0a8d40f6643f1 with
--   LF line ends); trg_vp_outbox_so read with pg_get_triggerdef is
--   20260927T0100's list; mfg_sales_orders has no vp_brand column and
--   scm.sync_config no vp.brands key (it holds vp.url, vp.secret, vp.since),
--   mfg_sales_order_items has branding and cancelled. Houzs
--   Century orders since 2026-08-01 by branding: AKEMI 456, ZANOTTI 137,
--   BEDFRAME 22, ERGOTEX 15, DUNLOPILLO 11, blank 3, SERVICE 3, NONE 2,
--   MYLATEX 1.
-- RE-RUN: ADD COLUMN IF NOT EXISTS, a CHECK added only when missing, the seed
--   ON CONFLICT DO NOTHING (an edited vp.brands is kept), CREATE OR REPLACE and
--   DROP TRIGGER IF EXISTS throughout.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- -- 1. The answer's own column ----------------------------------------------
ALTER TABLE scm.mfg_sales_orders ADD COLUMN IF NOT EXISTS vp_brand text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mfg_sales_orders_vp_brand_not_blank'
       AND conrelid = 'scm.mfg_sales_orders'::regclass
  ) THEN
    ALTER TABLE scm.mfg_sales_orders
      ADD CONSTRAINT mfg_sales_orders_vp_brand_not_blank
      CHECK (vp_brand IS NULL OR btrim(vp_brand) <> '');
  END IF;
END
$$;

COMMENT ON COLUMN scm.mfg_sales_orders.vp_brand IS
  'The brand this bill is FOR, for the Venture Portal only (owner 2026-09-27): asked by the order form after a save when nothing on the bill -- its branding or any line -- names a brand (a bed frame or accessory bill written at a brand''s fair), and skippable. One of the sync_config vp.brands names; NULL when never asked or skipped. Written by PUT /mfg-sales-orders/:docNo/vp-brand, sent to the portal as vpBrand, read by nothing in this system: branding is untouched by it.';

-- -- 2. Which brands the question offers ------------------------------------
-- The portal's margin ladders, beside the feed's other settings. Seeded only
-- when missing, so an edited list survives a re-run.
INSERT INTO scm.sync_config (k, v)
VALUES ('vp.brands', 'AKEMI,DUNLOPILLO,ERGOTEX,ZANOTTI')
ON CONFLICT (k) DO NOTHING;

-- -- 3. The order feed: each delivery carries the answer ----------------------
-- 20260927T0100's definition with ONE key added: 'vpBrand'.
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
  'Builds the Venture Portal delivery for each doc_no: header from scm.mfg_sales_orders_with_payment_totals minus customer PII, payments verbatim, items verbatim except variants (cut to fabricCode / seatHeight / legHeight / divanHeight / gap / totalHeight / size / specials, omitted when none), the salesperson behind salesperson_id, the fair the order was written at (fair: the picked project''s id, code, name, venue, organizer, brand, start/end date, status, event type, plus the order''s fair_match and fair_date; null when the order has no project), and vpBrand: the brand a person said the bill is for when its products name none (mfg_sales_orders.vp_brand; null when never asked or skipped). A doc_no with no header row returns {deleted:true}. Called once per drain sweep by scm/lib/venture-portal-outbox.ts.';

-- -- 4. An answer given after the save is a change the portal must hear -------
-- 20260927T0100's trigger, its UPDATE OF list plus vp_brand.
DROP TRIGGER IF EXISTS trg_vp_outbox_so ON scm.mfg_sales_orders;
CREATE TRIGGER trg_vp_outbox_so
  AFTER INSERT OR DELETE OR UPDATE OF
    status, on_hold, so_date, branding, salesperson_id, agent,
    debtor_name, debtor_code, sales_location, company_id,
    local_total_sen, subtotal_sen, balance_sen, deposit_sen, paid_sen,
    delivery_fee_sen, total_cost_sen, total_margin_sen,
    project_id, fair_match, fair_date, venue, venue_id,
    vp_brand
  ON scm.mfg_sales_orders
  FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox();
