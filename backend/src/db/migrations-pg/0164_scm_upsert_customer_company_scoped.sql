-- 0164 — upsert_customer_by_name_phone: scope by company_id to stop cross-company
--        customer binding.
--
-- BUG (audit finding, 2026-07-21).
--   port-missing-functions-triggers.sql:54-56 selects a customer by
--   (lower(btrim(name)), phone) with NO company_id filter. Post-2990-cutover,
--   a POS SO for a repeat 2990 customer whose name+phone matches a HOUZS
--   customer would silently rewire the SO to point at HOUZS's customer_id.
--   Once wired, every subsequent read for that customer under company_2
--   misses the correct row.
--
--   The customers_name_phone_unique constraint was already rescoped to
--   (name, phone, company_id) by mig 0123, so both rows CAN now coexist —
--   the bug was in the resolver, not the schema.
--
-- FIX. Add p_company_id bigint DEFAULT NULL as the 4th argument. Both SELECT
-- lookups and the INSERT now scope by company_id (COALESCE to HOUZS base when
-- caller passes NULL, matching create_product_with_pricing's pattern so
-- single-company Houzs behaviour is byte-identical).
--
-- CALL SITES. mfg-sales-orders.ts:3293 (SO create), :6206 (SO edit),
-- consignment-orders.ts:771. All updated in the same PR to pass p_company_id.
--
-- Rollback. `CREATE OR REPLACE` is idempotent + reversible by re-applying the
-- pre-fix body from port-missing-functions-triggers.sql.

CREATE OR REPLACE FUNCTION scm.upsert_customer_by_name_phone(
  p_name       text,
  p_phone      text,
  p_email      text DEFAULT NULL,
  p_company_id bigint DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_id         uuid;
  v_company_id bigint := COALESCE(p_company_id, (SELECT id FROM public.companies WHERE code = 'HOUZS'));
  v_alpha      text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code       text;
  i            int;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' OR p_phone IS NULL OR btrim(p_phone) = '' THEN
    RAISE EXCEPTION 'upsert_customer_by_name_phone: name and phone are both required';
  END IF;

  SELECT id INTO v_id FROM scm.customers
    WHERE company_id = v_company_id
      AND lower(btrim(name)) = lower(btrim(p_name))
      AND phone = p_phone
    LIMIT 1;
  IF FOUND THEN
    UPDATE scm.customers SET last_seen_at = now() WHERE id = v_id;
    RETURN v_id;
  END IF;

  LOOP
    v_code := '2990S-';
    FOR i IN 1..8 LOOP
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    END LOOP;
    BEGIN
      INSERT INTO scm.customers (name, phone, email, customer_code, company_id)
      VALUES (btrim(p_name), p_phone, NULLIF(btrim(coalesce(p_email, '')), ''), v_code, v_company_id)
      RETURNING id INTO v_id;
      RETURN v_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO v_id FROM scm.customers
        WHERE company_id = v_company_id
          AND lower(btrim(name)) = lower(btrim(p_name))
          AND phone = p_phone
        LIMIT 1;
      IF FOUND THEN
        UPDATE scm.customers SET last_seen_at = now() WHERE id = v_id;
        RETURN v_id;
      END IF;
    END;
  END LOOP;
END;
$$;
