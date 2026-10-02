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


-- ── A3. rename_sofa_compartment — REMOVED from this script ──────────────────
-- The ported body renamed compartment codes across EVERY company and rewrote
-- SKU codes + historical doc lines without the stock tables. It is replaced by
-- the company-scoped, preview-first 4-argument function in
-- backend/src/db/migrations-pg/*_scm_rename_sofa_compartment_scoped.sql, which
-- also drops this 2-argument one. Re-running this script must not bring it back.


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
