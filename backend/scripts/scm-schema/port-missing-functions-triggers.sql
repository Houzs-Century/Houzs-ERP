-- ----------------------------------------------------------------------------
-- scm — port of the hand-written PL/pgSQL FUNCTIONS + TRIGGERS that 2990's raw
-- migrations define but the Houzs `scm` schema dropped.
--
-- WHY THIS EXISTS
--   Houzs's `scm` schema was built from a Drizzle table/enum/FK export
--   (2990s-full-schema.sql) + a VIEWS-ONLY port (apply-scm-views.mjs regex-
--   extracts only CREATE VIEW). That silently dropped EVERY hand-written
--   function and trigger from 2990's raw `.sql` migrations. The FIFO inventory
--   trigger was the first casualty found + fixed (inventory-fifo-trigger.sql).
--   This file ports the OTHER missing objects that the ported SCM routes call
--   or that an scm table needs for correctness.
--
-- ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS
-- before CREATE TRIGGER. Touches no table data. Safe to re-run.
--
-- search_path: every function that does UNQUALIFIED table writes is created
-- with `SET search_path = scm, pg_temp` so it never resolves to a shadowing
-- public.* table (the exact bug that broke the FIFO trigger). Apply with
-- `SET LOCAL search_path TO scm, public` (the apply script does this).
-- ----------------------------------------------------------------------------


-- ════════════════════════════════════════════════════════════════════════════
-- A. RPCs CALLED BY MOUNTED SCM ROUTES (these were silently 500'ing / failing)
-- ════════════════════════════════════════════════════════════════════════════

-- ── A1. upsert_customer_by_name_phone — port of 2990 mig 0146 ───────────────
-- Called by: mfg-sales-orders.ts (SO create + SO customer-edit), consignment-
-- orders.ts (CSO create). Find-or-create one customer per (name, phone), mint a
-- readable 2990S-XXXXXXXX code on first sight, bump last_seen otherwise.
-- WITHOUT this, creating/editing an SO or CSO with a new customer fails.
-- Schema-pinned to scm (DEFINER kept for parity; under service-role it's moot,
-- but harmless and matches 2990).
CREATE OR REPLACE FUNCTION upsert_customer_by_name_phone(
  p_name  text,
  p_phone text,
  p_email text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_id    uuid;
  v_alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';  -- 31 chars, no 0/O/1/I/L
  v_code  text;
  i       int;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' OR p_phone IS NULL OR btrim(p_phone) = '' THEN
    RAISE EXCEPTION 'upsert_customer_by_name_phone: name and phone are both required';
  END IF;

  SELECT id INTO v_id FROM customers
    WHERE lower(btrim(name)) = lower(btrim(p_name)) AND phone = p_phone
    LIMIT 1;
  IF FOUND THEN
    UPDATE customers SET last_seen_at = now() WHERE id = v_id;
    RETURN v_id;
  END IF;

  LOOP
    v_code := '2990S-';
    FOR i IN 1..8 LOOP
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    END LOOP;
    BEGIN
      INSERT INTO customers (name, phone, email, customer_code)
      VALUES (btrim(p_name), p_phone, NULLIF(btrim(coalesce(p_email, '')), ''), v_code)
      RETURNING id INTO v_id;
      RETURN v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_id FROM customers
        WHERE lower(btrim(name)) = lower(btrim(p_name)) AND phone = p_phone
        LIMIT 1;
      IF FOUND THEN
        UPDATE customers SET last_seen_at = now() WHERE id = v_id;
        RETURN v_id;
      END IF;
    END;
  END LOOP;
END;
$$;


-- ── A2. create_product_with_pricing — port of 2990 mig 0044 ─────────────────
-- Called by: products.ts (POST /products). Inserts a product header + its
-- pricing children (compartments / bundles / fabrics for sofa_build; size
-- variants for size_variants). Reads only the jsonb arg.
-- NOTE: 2990 declares this SECURITY INVOKER + search_path=public; under Houzs's
-- service-role REST it runs as the service role anyway. Pinned to scm so the
-- inserts + the `pricing_kind` enum cast resolve to scm, not public.
-- MULTI-COMPANY (mig 0104): takes p_company_id and stamps it on the product +
-- every pricing child (products.company_id etc. are NOT NULL — mig 0083/0089 —
-- but only carry a HOUZS DEFAULT, so without an explicit stamp a product created
-- in 2990 context was silently labelled HOUZS). NULL → COALESCE to the HOUZS base
-- so single-company Houzs is unchanged. The old 1-arg overload is dropped in the
-- migration to avoid PostgREST ambiguity.
CREATE OR REPLACE FUNCTION create_product_with_pricing(p jsonb, p_company_id bigint DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_product_id uuid;
  v_kind text := p->>'pricingKind';
  v_company_id bigint := COALESCE(p_company_id, (SELECT id FROM public.companies WHERE code = 'HOUZS'));
BEGIN
  INSERT INTO products (
    sku, category_id, series_id, pricing_kind, name, detail, size_display,
    img_key, thumb_key, stock, low_at, visible, flat_price, recliner_upgrade_price, company_id
  ) VALUES (
    p->>'sku',
    p->>'categoryId',
    NULLIF(p->>'seriesId', ''),
    v_kind::pricing_kind,
    p->>'name',
    NULLIF(p->>'detail', ''),
    NULLIF(p->>'sizeDisplay', ''),
    p->>'imgKey',
    p->>'thumbKey',
    COALESCE((p->>'stock')::int, 0),
    COALESCE((p->>'lowAt')::int, 5),
    COALESCE((p->>'visible')::boolean, true),
    CASE WHEN v_kind = 'flat'       THEN (p->>'flatPrice')::int            ELSE NULL END,
    CASE WHEN v_kind = 'sofa_build' THEN (p->>'reclinerUpgradePrice')::int ELSE NULL END,
    v_company_id
  )
  RETURNING id INTO v_product_id;

  IF v_kind = 'sofa_build' THEN
    INSERT INTO product_compartments (product_id, compartment_id, active, price, company_id)
    SELECT v_product_id, (r->>'compartmentId')::text, (r->>'active')::boolean, (r->>'price')::int, v_company_id
    FROM jsonb_array_elements(p->'compartments') r;

    INSERT INTO product_bundles (product_id, bundle_id, active, price, company_id)
    SELECT v_product_id, (r->>'bundleId')::text, (r->>'active')::boolean, (r->>'price')::int, v_company_id
    FROM jsonb_array_elements(p->'bundles') r;

    INSERT INTO product_fabrics (product_id, fabric_id, active, surcharge, company_id)
    SELECT v_product_id, (r->>'fabricId')::text, (r->>'active')::boolean, (r->>'surcharge')::int, v_company_id
    FROM jsonb_array_elements(COALESCE(p->'fabrics', '[]'::jsonb)) r;
  ELSIF v_kind = 'size_variants' THEN
    INSERT INTO product_size_variants (product_id, size_id, active, price, company_id)
    SELECT v_product_id, (r->>'sizeId')::text, (r->>'active')::boolean, (r->>'price')::int, v_company_id
    FROM jsonb_array_elements(p->'sizes') r;
  END IF;

  RETURN v_product_id;
END;
$$;


-- ── A3. rename_sofa_compartment — port of 2990 mig 0149 ─────────────────────
-- Called by: maintenance-config.ts (POST /sofa-compartments/rename). Atomically
-- cascades a compartment-code rename across the SKU master + every doc-line
-- snapshot + Modular/combos/quick-picks/carts JSON + maintenance config blobs.
--
-- TWO DELIBERATE DEVIATIONS FROM THE 2990 SOURCE (both required for scm):
--   1) Three table names were renamed during the Houzs port. Remapped here:
--        consignment_note_items          -> consignment_delivery_order_items (item_code)
--        consignment_order_items         -> consignment_sales_order_items    (item_code)
--        purchase_consignment_note_items -> purchase_consignment_receive_items
--                                           (column is material_code, NOT item_code)
--   2) The 2990 body opens with `IF NOT is_admin() THEN RAISE forbidden`. scm
--      has no is_admin()/auth machinery (it runs under the service role, RLS
--      bypassed, exactly like every other ported SCM route). The admin gate now
--      lives in the route/RBAC layer — the DB-level gate is dropped here, in
--      line with all other scm functions. (Behaviour change — flagged.)
CREATE OR REPLACE FUNCTION rename_sofa_compartment(p_from text, p_to text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_from    text := trim(p_from);
  v_to      text := trim(p_to);
  tok_from  text;
  tok_to    text;
  counts    jsonb := '{}'::jsonb;
  n         int;
  re_from   text;
BEGIN
  IF v_from = '' OR v_to = '' THEN
    RAISE EXCEPTION 'empty_code';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'same_code';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM maintenance_config_history h
     WHERE h.scope = 'master'
       AND h.effective_from <= CURRENT_DATE
       AND (h.config->'sofaCompartments') ? v_to
     ORDER BY h.effective_from DESC, h.created_at DESC
     LIMIT 1
  ) THEN
    RAISE EXCEPTION 'code_exists';
  END IF;

  tok_from := to_jsonb(v_from)::text;
  tok_to   := to_jsonb(v_to)::text;
  re_from  := regexp_replace(v_from, '([\^$.|?*+()\[\]{}])', '\\\1', 'g');

  -- ── SKU master: code suffix + name suffix ────────────────────────────
  UPDATE mfg_products
     SET code = left(code, length(code) - length(v_from)) || v_to,
         name = CASE WHEN right(name, length(v_from) + 1) = ' ' || v_from
                     THEN left(name, length(name) - length(v_from)) || v_to
                     ELSE name END
   WHERE category = 'SOFA'
     AND right(code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('mfg_products', n);

  -- ── Doc line code suffixes (TEXT snapshots across the doc flow) ──────
  UPDATE mfg_sales_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_sales_order_items_code', n);

  UPDATE mfg_so_price_overrides SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_so_price_overrides', n);

  UPDATE delivery_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('delivery_order_items', n);

  UPDATE delivery_return_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('delivery_return_items', n);

  UPDATE sales_invoice_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sales_invoice_items', n);

  -- consignment_note_items (2990) -> consignment_delivery_order_items (scm)
  UPDATE consignment_delivery_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('consignment_delivery_order_items', n);

  -- consignment_order_items (2990) -> consignment_sales_order_items (scm)
  UPDATE consignment_sales_order_items SET item_code = left(item_code, length(item_code) - length(v_from)) || v_to
   WHERE right(item_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('consignment_sales_order_items', n);

  -- purchase_consignment_note_items (2990) -> purchase_consignment_receive_items (scm);
  -- column is material_code on the scm side (NOT item_code).
  UPDATE purchase_consignment_receive_items SET material_code = left(material_code, length(material_code) - length(v_from)) || v_to
   WHERE right(material_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_consignment_receive_items', n);

  UPDATE grn_items SET
         material_code = CASE WHEN right(material_code, length(v_from) + 1) = '-' || v_from
                              THEN left(material_code, length(material_code) - length(v_from)) || v_to ELSE material_code END,
         supplier_sku  = CASE WHEN right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from
                              THEN left(supplier_sku, length(supplier_sku) - length(v_from)) || v_to ELSE supplier_sku END
   WHERE right(material_code, length(v_from) + 1) = '-' || v_from
      OR right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('grn_items', n);

  UPDATE purchase_order_items SET
         material_code = CASE WHEN right(material_code, length(v_from) + 1) = '-' || v_from
                              THEN left(material_code, length(material_code) - length(v_from)) || v_to ELSE material_code END,
         supplier_sku  = CASE WHEN right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from
                              THEN left(supplier_sku, length(supplier_sku) - length(v_from)) || v_to ELSE supplier_sku END
   WHERE right(material_code, length(v_from) + 1) = '-' || v_from
      OR right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_order_items', n);

  UPDATE purchase_consignment_order_items SET material_code = left(material_code, length(material_code) - length(v_from)) || v_to
   WHERE right(material_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_consignment_order_items', n);

  UPDATE purchase_invoice_items SET material_code = left(material_code, length(material_code) - length(v_from)) || v_to
   WHERE right(material_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_invoice_items', n);

  UPDATE purchase_return_items SET material_code = left(material_code, length(material_code) - length(v_from)) || v_to
   WHERE right(material_code, length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('purchase_return_items', n);

  UPDATE supplier_material_bindings SET
         material_code = CASE WHEN right(material_code, length(v_from) + 1) = '-' || v_from
                              THEN left(material_code, length(material_code) - length(v_from)) || v_to ELSE material_code END,
         supplier_sku  = CASE WHEN right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from
                              THEN left(supplier_sku, length(supplier_sku) - length(v_from)) || v_to ELSE supplier_sku END
   WHERE right(material_code, length(v_from) + 1) = '-' || v_from
      OR right(coalesce(supplier_sku, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('supplier_material_bindings', n);

  UPDATE pwp_codes SET
         trigger_item_code  = CASE WHEN right(coalesce(trigger_item_code, ''), length(v_from) + 1) = '-' || v_from
                                   THEN left(trigger_item_code, length(trigger_item_code) - length(v_from)) || v_to ELSE trigger_item_code END,
         redeemed_item_code = CASE WHEN right(coalesce(redeemed_item_code, ''), length(v_from) + 1) = '-' || v_from
                                   THEN left(redeemed_item_code, length(redeemed_item_code) - length(v_from)) || v_to ELSE redeemed_item_code END
   WHERE right(coalesce(trigger_item_code, ''), length(v_from) + 1) = '-' || v_from
      OR right(coalesce(redeemed_item_code, ''), length(v_from) + 1) = '-' || v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('pwp_codes', n);

  -- ── Plain-text descriptions (word-boundary rename) ───────────────────
  UPDATE mfg_sales_order_items
     SET description  = regexp_replace(description,  '(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])', '\1' || v_to || '\2', 'g'),
         description2 = CASE WHEN description2 IS NOT NULL
                             THEN regexp_replace(description2, '(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])', '\1' || v_to || '\2', 'g')
                             ELSE description2 END
   WHERE description ~ ('(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])')
      OR coalesce(description2, '') ~ ('(^|[^A-Za-z0-9)])' || re_from || '($|[^A-Za-z0-9(])');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_sales_order_items_desc', n);

  -- ── JSONB token replacements ─────────────────────────────────────────
  UPDATE product_models
     SET allowed_options = replace(allowed_options::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in allowed_options::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('product_models', n);

  UPDATE sofa_combo_pricing
     SET modules = replace(modules::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in modules::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sofa_combo_pricing', n);

  UPDATE sofa_quick_picks
     SET modules = replace(modules::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in modules::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sofa_quick_picks', n);

  UPDATE sofa_personal_quick_picks
     SET modules = replace(modules::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in modules::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('sofa_personal_quick_picks', n);

  UPDATE pos_carts
     SET lines = replace(lines::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in lines::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('pos_carts', n);

  UPDATE mfg_sales_order_items
     SET variants = replace(variants::text, tok_from, tok_to)::jsonb
   WHERE variants IS NOT NULL AND position(tok_from in variants::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mfg_sales_order_items_variants', n);

  UPDATE maintenance_config_history
     SET config = replace(config::text, tok_from, tok_to)::jsonb
   WHERE position(tok_from in config::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('maintenance_config_history', n);

  -- ── Legacy retail compartment library + per-Model pricing ───────────
  INSERT INTO compartment_library (id, comp_group, label, width_cm, depth_cm, cushions, default_price, art_filename, is_accessory, sort_order)
  SELECT v_to, comp_group, label, width_cm, depth_cm, cushions, default_price, art_filename, is_accessory, sort_order
    FROM compartment_library WHERE id = v_from
  ON CONFLICT (id) DO NOTHING;

  UPDATE product_compartments SET compartment_id = v_to WHERE compartment_id = v_from;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('product_compartments', n);

  DELETE FROM compartment_library
   WHERE id = v_from AND EXISTS (SELECT 1 FROM compartment_library WHERE id = v_to);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('compartment_library', n);

  RETURN jsonb_build_object('from', v_from, 'to', v_to, 'changed', counts);
END;
$fn$;


-- ════════════════════════════════════════════════════════════════════════════
-- B. CORRECTNESS TRIGGER ON AN scm TABLE
-- ════════════════════════════════════════════════════════════════════════════

-- ── B1. fn_check_je_balanced + trg_je_balanced — port of 2990 mig 0052 ──────
-- BEFORE UPDATE on journal_entries: when a JE transitions to posted=true it must
-- balance (sum debits = sum credits, non-zero), else the post is rejected. Also
-- stamps total_debit_sen/total_credit_sen/posted_at. The scm accounting routes
-- post JEs; without this guard an unbalanced GL could be posted silently.
CREATE OR REPLACE FUNCTION fn_check_je_balanced()
RETURNS TRIGGER
SET search_path = scm, pg_temp
AS $$
DECLARE
  debit_sum INTEGER;
  credit_sum INTEGER;
BEGIN
  IF NEW.posted = TRUE AND (OLD.posted IS DISTINCT FROM TRUE) THEN
    SELECT COALESCE(SUM(debit_sen), 0), COALESCE(SUM(credit_sen), 0)
      INTO debit_sum, credit_sum
      FROM journal_entry_lines WHERE journal_entry_id = NEW.id;

    IF debit_sum <> credit_sum THEN
      RAISE EXCEPTION 'Journal entry % is not balanced: debit=% credit=%',
        NEW.je_no, debit_sum, credit_sum;
    END IF;

    IF debit_sum = 0 THEN
      RAISE EXCEPTION 'Journal entry % has no lines', NEW.je_no;
    END IF;

    NEW.total_debit_sen  := debit_sum;
    NEW.total_credit_sen := credit_sum;
    NEW.posted_at        := COALESCE(NEW.posted_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_je_balanced ON journal_entries;
CREATE TRIGGER trg_je_balanced
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_check_je_balanced();


-- ════════════════════════════════════════════════════════════════════════════
-- C. FUNCTIONS REFERENCED BY VENDORED-BUT-CURRENTLY-UNWIRED LIBS
--    (reaper.ts, pin-rate-limit.ts). Ported defensively: the lib code calls
--    them by name, the tables exist, and they're cheap + side-effect-safe.
-- ════════════════════════════════════════════════════════════════════════════

-- ── C1. lease_orphan_slips + count_orphan_slips — port of 2990 mig 0011 ─────
CREATE OR REPLACE FUNCTION lease_orphan_slips(p_worker_id text, p_limit integer DEFAULT 100)
RETURNS TABLE(id uuid, r2_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE pending_slip_uploads psu
     SET claimed_by = p_worker_id,
         lease_expires_at = now() + INTERVAL '5 minutes'
   WHERE psu.id IN (
     SELECT psu2.id
       FROM pending_slip_uploads psu2
      WHERE psu2.status IN ('pending','uploaded')
        AND psu2.expires_at < now()
        AND (psu2.claimed_by IS NULL OR psu2.lease_expires_at < now())
      ORDER BY psu2.expires_at
      FOR UPDATE SKIP LOCKED
      LIMIT p_limit
   )
   RETURNING psu.id, psu.r2_key;
END;
$$;

CREATE OR REPLACE FUNCTION count_orphan_slips()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
  SELECT COUNT(*)::integer
    FROM pending_slip_uploads
   WHERE status IN ('pending','uploaded')
     AND expires_at < now();
$$;

-- ── C2. pin_attempt_check / _fail / _reset — port of 2990 mig 0119 ──────────
CREATE OR REPLACE FUNCTION pin_attempt_check(p_staff_id UUID, p_max INT)
RETURNS TABLE(allowed BOOLEAN, retry_after INT, remaining INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = scm, pg_temp AS $$
DECLARE r pos_pin_attempts%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pos_pin_attempts WHERE staff_id = p_staff_id;
  IF NOT FOUND OR r.reset_at <= NOW() THEN
    RETURN QUERY SELECT TRUE, 0, p_max;
  ELSIF r.count >= p_max THEN
    RETURN QUERY SELECT FALSE, CEIL(EXTRACT(EPOCH FROM (r.reset_at - NOW())))::INT, 0;
  ELSE
    RETURN QUERY SELECT TRUE, 0, (p_max - r.count);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pin_attempt_fail(p_staff_id UUID, p_window_seconds INT)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = scm, pg_temp AS $$
  INSERT INTO pos_pin_attempts (staff_id, count, reset_at)
  VALUES (p_staff_id, 1, NOW() + make_interval(secs => p_window_seconds))
  ON CONFLICT (staff_id) DO UPDATE SET
    count    = CASE WHEN pos_pin_attempts.reset_at <= NOW() THEN 1
                    ELSE pos_pin_attempts.count + 1 END,
    reset_at = CASE WHEN pos_pin_attempts.reset_at <= NOW() THEN NOW() + make_interval(secs => p_window_seconds)
                    ELSE pos_pin_attempts.reset_at END;
$$;

CREATE OR REPLACE FUNCTION pin_attempt_reset(p_staff_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = scm, pg_temp AS $$
  DELETE FROM pos_pin_attempts WHERE staff_id = p_staff_id;
$$;
