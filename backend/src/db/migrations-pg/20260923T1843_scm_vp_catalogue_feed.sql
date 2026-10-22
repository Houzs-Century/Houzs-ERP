-- 20260923T1843_scm_vp_catalogue_feed.sql
--
-- ERP -> Venture Portal: the CATALOGUE push (items only), and structured
-- variants on the order feed's lines.
--
-- WHY. The portal's Revenue > Product List mirrors our Products page — SKU
-- Master, Modular models with their allowed options, the Bedframe / Sofa
-- maintenance pools, specials, fabrics and sofa combos — so its calculator can
-- only offer what we actually make. The owner's rule for that mirror is ITEMS
-- ONLY: every price the portal measures a margin against is typed over there,
-- so not one price or cost may leave this database. Receiver: POST
-- /api/erp/v1/products (contract v2), on the same key as the order feed.
--
-- MONEY IS STRIPPED HERE, BY ALLOWLIST, never by the Worker. Every row is a
-- jsonb_build_object of named columns, so a price column added to a source
-- table later cannot ride along. The free-form JSON that does travel is
-- reduced or guarded:
--   - maintenance pool entries become a bare string or {value, active} — the
--     entry's priceSen (a COST surcharge) never leaves;
--   - combos carry the KEYS of prices_by_height (the seat heights on offer),
--     never a value;
--   - models' allowed_options and combos' modules go through
--     scm.vp_strip_money_keys, which drops any price/cost-named key at any
--     depth. Measured 2026-09-24: neither column holds one in either company,
--     so today both travel verbatim — the guard is for the next writer.
--
-- THE DIGEST. vp_build_catalogue has no timestamp and orders every array by
-- id, so an unchanged catalogue has an unchanged md5. The */5 cron asks for
-- the digest (32 bytes over the wire) and only builds and sends the body when
-- it differs from the last one the portal accepted. vp_catalogue_snapshot
-- returns the body WITH its own digest from one build, so the digest recorded
-- as delivered always describes the bytes that were actually sent.
--
-- WHICH MAINTENANCE ROW. The ERP's own resolver (routes/maintenance-config.ts
-- GET /resolved): scope 'master', effective_from <= today, newest
-- effective_from then newest created_at — with "today" in MALAYSIA, as
-- todayMyt() computes it. The database runs in UTC, so current_date would
-- flip a future-dated price change eight hours late.
--
-- THE ORDER FEED. vp_build_payloads sent every line as to_jsonb(i), which
-- includes the WHOLE variants column: extraAddonAmountRM (money), remark and
-- extraAddonNote (free text) and the rest. It now sends an allowlisted
-- variants object instead — fabricCode, seatHeight, legHeight, divanHeight,
-- gap, totalHeight, size, specials (string elements only) — and omits it when
-- the line has none of those keys. The portal's line parser
-- (catalogue_line_facts) reads exactly those keys and falls back to
-- description2 when the object is absent. Everything else in that function is
-- unchanged, byte for byte.
--
-- REVERSAL: DROP FUNCTION IF EXISTS scm.vp_catalogue_snapshot(bigint),
--   scm.vp_catalogue_digest(bigint), scm.vp_build_catalogue(bigint),
--   scm.vp_strip_money_keys(jsonb); DROP TABLE IF EXISTS
--   scm.venture_portal_catalogue_state; then re-run the CREATE OR REPLACE
--   FUNCTION scm.vp_build_payloads block of 20260912T1800 verbatim (which puts
--   the whole variants column back on every line, extraAddonAmountRM
--   included). No existing table is altered and no grant is lost: CREATE OR
--   REPLACE keeps vp_build_payloads' ACL.
-- Verified against: production (anogrigyjbduyzclzjgn), read-only via the
--   Supabase MCP on 2026-09-24. The body of vp_build_catalogue(1) ran as a
--   plain SELECT: products 2,350, models 703, specials 35, fabrics 950,
--   combos 97 master rows (21 soft-deleted), 6 pools / 69 entries; 1,247,165
--   bytes as jsonb text; ~0.2 s warm; the same md5 on two runs. Every key of
--   the built body was enumerated: none is a price, cost or *_sen; the only
--   'price' substrings are the fabric tier names and their PRICE_n values.
--   vp_build_payloads was read with pg_get_functiondef and matches
--   20260912T1800 exactly.
-- RE-RUN: no-op. CREATE OR REPLACE / IF NOT EXISTS throughout.

-- ── The money guard ─────────────────────────────────────────────────────────
-- A jsonb value with every price/cost-named key removed, at any depth. The
-- predicate is spelled twice, once as jsonpath (a C-speed "is there anything
-- to strip?" that returns today's values untouched) and once as SQL for the
-- walk; keep the two in step.
CREATE OR REPLACE FUNCTION scm.vp_strip_money_keys(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = scm, public
AS $fn$
BEGIN
  IF p_value IS NULL OR NOT jsonb_path_exists(p_value,
       'lax $.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "price|cost|amount|surcharge|discount|margin|_sen$" flag "i" || @.key like_regex "(Sen|RM)$")') THEN
    RETURN p_value;
  END IF;

  IF jsonb_typeof(p_value) = 'object' THEN
    RETURN COALESCE((
      SELECT jsonb_object_agg(e.key, scm.vp_strip_money_keys(e.value))
        FROM jsonb_each(p_value) AS e
       WHERE NOT (e.key ~* '(price|cost|amount|surcharge|discount|margin|_sen$)'
                  OR e.key ~ '(Sen|RM)$')), '{}'::jsonb);
  END IF;

  -- An array with an offending object somewhere inside it.
  RETURN (
    SELECT jsonb_agg(scm.vp_strip_money_keys(e.value) ORDER BY e.ord)
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, ord));
END
$fn$;

COMMENT ON FUNCTION scm.vp_strip_money_keys(jsonb) IS
  'The Venture Portal catalogue feed''s money guard: the value with every key named like a price, cost, amount, surcharge, discount, margin, *_sen, *Sen or *RM removed at any depth. Returns the value untouched when there is none.';

-- ── The catalogue ───────────────────────────────────────────────────────────
-- One company's whole catalogue as ONE delivery body, in the receiver's
-- contract v2 shape. `full: true` tells the portal to retire any row of a
-- carried section that the body does not mention, which is why a section is
-- never split across two posts (the sender splits by section only).
CREATE OR REPLACE FUNCTION scm.vp_build_catalogue(p_company_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = scm, public
AS $fn$
  SELECT jsonb_build_object(
           'companyId', p_company_id,
           'full', true,
           -- SKU Master. Inactive SKUs travel too: status says so.
           'products', COALESCE((
             SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'id', p.id,
                      'code', p.code,
                      'name', p.name,
                      'description', p.description,
                      'category', p.category,
                      'model_id', p.model_id,
                      'base_model', p.base_model,
                      'size_code', p.size_code,
                      'size_label', p.size_label,
                      'branding', p.branding,
                      'barcode', p.barcode,
                      'fabric_color', p.fabric_color,
                      'status', p.status,
                      'updated_at', p.updated_at))
                    ORDER BY p.id COLLATE "C")
               FROM scm.mfg_products p
              WHERE p.company_id = p_company_id), '[]'::jsonb),
           -- Modular. allowed_options is added after jsonb_strip_nulls so it
           -- arrives as stored.
           'models', COALESCE((
             SELECT jsonb_agg(
                      jsonb_strip_nulls(jsonb_build_object(
                        'id', m.id,
                        'model_code', m.model_code,
                        'name', m.name,
                        'category', m.category,
                        'branding', m.branding,
                        'description', m.description,
                        'active', m.active,
                        'updated_at', m.updated_at))
                      || CASE WHEN m.allowed_options IS NULL THEN '{}'::jsonb
                              ELSE jsonb_build_object('allowed_options', scm.vp_strip_money_keys(m.allowed_options))
                         END
                      ORDER BY m.id)
               FROM scm.product_models m
              WHERE m.company_id = p_company_id), '[]'::jsonb),
           -- No selling_price_sen, cost_price_sen or option_groups.
           'specials', COALESCE((
             SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'id', s.id,
                      'code', s.code,
                      'label', s.label,
                      'categories', to_jsonb(s.categories),
                      'active', s.active,
                      'sort_order', s.sort_order))
                    ORDER BY s.id)
               FROM scm.special_addons s
              WHERE s.company_id = p_company_id), '[]'::jsonb),
           -- The PRICE_n tiers are labels the portal prices by; price_sen,
           -- stock, usage and supplier columns stay here.
           'fabrics', COALESCE((
             SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                      'id', f.id,
                      'fabric_code', f.fabric_code,
                      'fabric_description', f.fabric_description,
                      'fabric_category', f.fabric_category,
                      'series', f.series,
                      'sofa_price_tier', f.sofa_price_tier,
                      'bedframe_price_tier', f.bedframe_price_tier,
                      'price_tier', f.price_tier,
                      'is_active', f.is_active))
                    ORDER BY f.id COLLATE "C")
               FROM scm.fabric_trackings f
              WHERE f.company_id = p_company_id), '[]'::jsonb),
           -- Master rows only (no customer, no supplier), soft-deleted ones
           -- included so the portal can retire them. heights = the keys of
           -- the cost grid, never its values.
           'combos', COALESCE((
             SELECT jsonb_agg(
                      jsonb_strip_nulls(jsonb_build_object(
                        'id', c.id,
                        'base_model', c.base_model,
                        'tier', c.tier,
                        'label', c.label,
                        'effective_from', c.effective_from,
                        'created_at', c.created_at,
                        'deleted_at', c.deleted_at,
                        'heights', COALESCE((
                          SELECT jsonb_agg(h ORDER BY h COLLATE "C")
                            FROM jsonb_object_keys(CASE WHEN jsonb_typeof(c.prices_by_height) = 'object'
                                                        THEN c.prices_by_height ELSE '{}'::jsonb END) AS h), '[]'::jsonb)))
                      || CASE WHEN c.modules IS NULL THEN '{}'::jsonb
                              ELSE jsonb_build_object('modules', scm.vp_strip_money_keys(c.modules))
                         END
                      ORDER BY c.id)
               FROM scm.sofa_combo_pricing c
              WHERE c.company_id = p_company_id
                AND c.customer_id IS NULL
                AND c.supplier_id IS NULL), '[]'::jsonb))
         -- Maintenance: the six Bedframe / Sofa pools of the effective master
         -- row. Absent when the company has none, so the portal leaves its
         -- copy alone rather than emptying it.
         || COALESCE((
              SELECT jsonb_build_object('maintenance', jsonb_build_object(
                       'effective_from', h.effective_from,
                       'pools', COALESCE((
                         SELECT jsonb_object_agg(k.key, COALESCE((
                                  SELECT jsonb_agg(
                                           CASE jsonb_typeof(e.entry)
                                             WHEN 'string' THEN e.entry
                                             ELSE jsonb_build_object(
                                                    'value', e.entry ->> 'value',
                                                    'active', (e.entry -> 'active') IS DISTINCT FROM 'false'::jsonb)
                                           END
                                           ORDER BY e.ord)
                                    FROM jsonb_array_elements(h.config -> k.key) WITH ORDINALITY AS e(entry, ord)
                                   WHERE jsonb_typeof(e.entry) = 'string'
                                      OR (jsonb_typeof(e.entry) = 'object'
                                          AND jsonb_typeof(e.entry -> 'value') IN ('string', 'number'))), '[]'::jsonb))
                           FROM unnest(ARRAY['divanHeights', 'totalHeights', 'gaps',
                                             'legHeights', 'sofaSizes', 'sofaLegHeights']) AS k(key)
                          WHERE jsonb_typeof(h.config -> k.key) = 'array'), '{}'::jsonb)))
                FROM scm.maintenance_config_history h
               WHERE h.company_id = p_company_id
                 AND h.scope = 'master'
                 AND h.effective_from <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
               ORDER BY h.effective_from DESC, h.created_at DESC, h.id COLLATE "C" DESC
               LIMIT 1), '{}'::jsonb)
$fn$;

COMMENT ON FUNCTION scm.vp_build_catalogue(bigint) IS
  'One company''s catalogue as a Venture Portal delivery body (contract v2): products, models + allowed_options, maintenance pools, specials, fabrics, master combos. Allowlisted columns only — no price or cost of any kind. Deterministic (every array ordered by id, no timestamp), so md5 of it is a stable digest. Sent by scm/lib/venture-portal-catalogue.ts.';

-- The cheap question the cron asks every five minutes.
CREATE OR REPLACE FUNCTION scm.vp_catalogue_digest(p_company_id bigint)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = scm, public
AS $fn$
  SELECT md5(scm.vp_build_catalogue(p_company_id)::text)
$fn$;

COMMENT ON FUNCTION scm.vp_catalogue_digest(bigint) IS
  'md5 of scm.vp_build_catalogue(p_company_id)::text — changes exactly when the catalogue the portal would receive changes.';

-- The body and ITS digest, from one build.
CREATE OR REPLACE FUNCTION scm.vp_catalogue_snapshot(p_company_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = scm, public
AS $fn$
DECLARE
  body jsonb := scm.vp_build_catalogue(p_company_id);
BEGIN
  RETURN jsonb_build_object('digest', md5(body::text), 'body', body);
END
$fn$;

COMMENT ON FUNCTION scm.vp_catalogue_snapshot(bigint) IS
  '{digest, body} from ONE vp_build_catalogue call, so the digest the sender records as delivered describes exactly the body it sent.';

-- ── What the sender last delivered ──────────────────────────────────────────
-- One row per company. The sender skips a company whose digest equals
-- delivered_digest, and also one whose digest the portal already refused with
-- a 400/422 (last_outcome 'failed') — the same bytes would be refused again.
-- delivered_digest is cleared whenever the portal MAY hold something else (a
-- later part applied, or an answer that never came back), so the next run
-- re-sends instead of trusting it.
-- last_outcome is classifyVpResponse's vocabulary (venture-portal-outbox.ts).
-- Like scm.venture_portal_outbox: no RLS; the schema is closed to anon and
-- authenticated, and the service role is granted below.
CREATE TABLE IF NOT EXISTS scm.venture_portal_catalogue_state (
  company_id        bigint      PRIMARY KEY,
  delivered_digest  text,
  delivered_at      timestamptz,
  portal_result     jsonb,
  last_digest       text,
  last_outcome      text        CHECK (last_outcome IN ('sent', 'failed', 'retry')),
  last_attempt_at   timestamptz,
  last_http_status  integer,
  last_error        text,
  last_bytes        integer,
  last_parts        integer,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm.venture_portal_catalogue_state IS
  'ERP -> Venture Portal catalogue push: per company, the digest of the last catalogue the portal accepted in full, and the outcome of the latest attempt (sent / failed = 400/422, not retried until the catalogue changes or a person forces it / retry). Written by scm/lib/venture-portal-catalogue.ts.';

-- ── The order feed: lines carry an allowlisted variants object ──────────────
-- 20260912T1800's definition with ONE expression changed: 'items'.
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
      'salesperson', sp);
  END LOOP;

  RETURN out_rows;
END
$fn$;

COMMENT ON FUNCTION scm.vp_build_payloads(text[]) IS
  'Builds the Venture Portal delivery for each doc_no: header from scm.mfg_sales_orders_with_payment_totals minus customer PII, payments verbatim, items verbatim except variants (cut to fabricCode / seatHeight / legHeight / divanHeight / gap / totalHeight / size / specials, omitted when none), plus the salesperson behind salesperson_id. A doc_no with no header row returns {deleted:true}. Called once per drain sweep by scm/lib/venture-portal-outbox.ts.';

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The PostgREST service role is the only caller. Hyperdrive origin roles are
-- matched by prefix, as 20260912T1800 does, because their names live in
-- Cloudflare connection strings and in no file here.
DO $grant$
DECLARE
  g  record;
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'scm.vp_strip_money_keys(jsonb)',
    'scm.vp_build_catalogue(bigint)',
    'scm.vp_catalogue_digest(bigint)',
    'scm.vp_catalogue_snapshot(bigint)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
    FOR g IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'hyperdrive%' LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, g.rolname);
    END LOOP;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.venture_portal_catalogue_state TO service_role;
  END IF;
END
$grant$;
