-- 0328_scm_so_header_cas_rebind_line_ids.sql (Postgres)
-- The State-change warehouse rebind learns to move VERIFIED lines, not only
-- NULL ones. Since the operator-store create default (same change, route
-- side), a POS walk-in order is born with its lines bound to the operator's
-- showroom and gets its address later — so the header PATCH must be able to
-- move those store-bound lines to the State's warehouse. The ROUTE decides
-- which bound lines are safe (no live downstream PO/DO —
-- lib/so-state-warehouse-rebind.ts) and passes their ids; this function only
-- executes the move inside the same transaction as the header CAS, so a stale
-- editor whose CAS loses cannot have half-moved lines.
--
-- The function body is otherwise byte-identical to migration 0173's (checked
-- against it when this file was generated). Same reason as 0173 for the DROP:
-- CREATE OR REPLACE cannot change an argument list — it creates an OVERLOAD,
-- and the named-args PostgREST call would then raise "function is not unique".

DROP FUNCTION IF EXISTS scm.apply_so_header_cas(
  text, integer, text, jsonb, boolean, text, text, text, boolean, uuid, boolean, date, bigint
);

CREATE OR REPLACE FUNCTION scm.apply_so_header_cas(
  p_doc_no text,
  p_expected_version integer,
  p_required_lease text,
  p_patch jsonb,
  p_recustomer boolean DEFAULT false,
  p_customer_name text DEFAULT NULL,
  p_customer_phone text DEFAULT NULL,
  p_customer_email text DEFAULT NULL,
  p_apply_warehouse boolean DEFAULT false,
  p_warehouse_id uuid DEFAULT NULL,
  p_apply_delivery_date boolean DEFAULT false,
  p_delivery_date date DEFAULT NULL,
  -- Multi-company: the customer upsert below MUST be told which company it is
  -- resolving in. Migration 0164 added p_company_id to
  -- upsert_customer_by_name_phone precisely because the unscoped call pooled
  -- Houzs and 2990 customers; calling the 3-arg form here would silently
  -- default every re-customer to the HOUZS row and re-open that hole.
  p_company_id bigint DEFAULT NULL,
  -- 0328 — line ids the ROUTE has verified safe to move (bound to another
  -- warehouse but with NO live downstream PO/DO). They follow the order to
  -- p_warehouse_id in the same transaction as the NULL-line rebind below.
  -- NULL = only NULL-warehouse lines rebind (the pre-0328 behaviour).
  p_rebind_line_ids uuid[] DEFAULT NULL
) RETURNS TABLE(
  applied boolean,
  current_version integer,
  resolved_customer_id uuid,
  conflict_reason text
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = scm, pg_temp AS $$
DECLARE
  v_row scm.mfg_sales_orders%ROWTYPE;
  v_saved_version integer;
  v_customer_id uuid;
  v_assignments text;
  v_sql text;
BEGIN
  SELECT * INTO v_row
  FROM mfg_sales_orders
  WHERE doc_no = p_doc_no
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::integer, NULL::uuid, 'not_found'::text;
    RETURN;
  END IF;
  IF v_row.version <> p_expected_version THEN
    RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'version'::text;
    RETURN;
  END IF;
  IF p_required_lease IS NOT NULL THEN
    IF v_row.edit_lease_token IS DISTINCT FROM p_required_lease
       OR v_row.edit_lease_expires_at IS NULL
       OR v_row.edit_lease_expires_at <= now() THEN
      RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'lease'::text;
      RETURN;
    END IF;
  ELSIF v_row.edit_lease_token IS NOT NULL
        AND v_row.edit_lease_expires_at IS NOT NULL
        AND v_row.edit_lease_expires_at > now() THEN
    RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'lease'::text;
    RETURN;
  END IF;

  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Sales Order CAS patch must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(
    format(
      '%1$I = CASE WHEN $1 ? %2$L THEN p.%1$I ELSE t.%1$I END',
      a.attname,
      a.attname
    ),
    ', ' ORDER BY a.attnum
  )
  INTO v_assignments
  FROM pg_attribute a
  WHERE a.attrelid = 'scm.mfg_sales_orders'::regclass
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND a.attgenerated = ''
    AND a.attidentity = ''
    AND a.attname <> 'doc_no';

  v_sql := format(
    'UPDATE scm.mfg_sales_orders AS t '
    'SET %1$s '
    'FROM jsonb_populate_record(NULL::scm.mfg_sales_orders, $1) AS p '
    'WHERE t.doc_no = $2 AND t.version = $3 RETURNING t.version',
    v_assignments
  );
  EXECUTE v_sql INTO v_saved_version USING p_patch, p_doc_no, p_expected_version;
  IF v_saved_version IS NULL THEN
    RETURN QUERY SELECT false, v_row.version, NULL::uuid, 'version'::text;
    RETURN;
  END IF;

  IF p_recustomer
     AND NULLIF(btrim(p_customer_name), '') IS NOT NULL
     AND NULLIF(btrim(p_customer_phone), '') IS NOT NULL THEN
    v_customer_id := upsert_customer_by_name_phone(
      p_customer_name, p_customer_phone, p_customer_email, p_company_id
    );
    UPDATE mfg_sales_orders
    SET customer_id = v_customer_id
    WHERE doc_no = p_doc_no AND version = v_saved_version;
    UPDATE pwp_codes
    SET customer_id = v_customer_id, updated_at = now()
    WHERE source_doc_no = p_doc_no;
  END IF;

  IF p_apply_warehouse AND p_warehouse_id IS NOT NULL THEN
    UPDATE mfg_sales_order_items
    SET warehouse_id = p_warehouse_id
    WHERE doc_no = p_doc_no AND cancelled = false
      AND (warehouse_id IS NULL
           OR (p_rebind_line_ids IS NOT NULL AND id = ANY(p_rebind_line_ids)));
  END IF;
  IF p_apply_delivery_date THEN
    UPDATE mfg_sales_order_items
    SET line_delivery_date = p_delivery_date,
        line_delivery_date_overridden = false
    WHERE doc_no = p_doc_no;
  END IF;

  RETURN QUERY SELECT true, v_saved_version, v_customer_id, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION scm.apply_so_header_cas(
  text, integer, text, jsonb, boolean, text, text, text, boolean, uuid, boolean, date, bigint, uuid[]
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.apply_so_header_cas(
  text, integer, text, jsonb, boolean, text, text, text, boolean, uuid, boolean, date, bigint, uuid[]
) TO service_role;

NOTIFY pgrst, 'reload schema';
