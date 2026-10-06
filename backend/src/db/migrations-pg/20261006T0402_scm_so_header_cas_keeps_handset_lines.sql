-- 20261006T0402_scm_so_header_cas_keeps_handset_lines.sql (Postgres)
-- A Sales Order header Delivery Date change no longer overwrites a line date
-- somebody set by hand.
--
-- OWNER RULING 2026-10-06 (Weisiang): "if users change the lines date still
-- follow the users, this is highest rules". Confirmed for Sales Orders too.
--
-- WHAT CHANGES. One UPDATE at the end of apply_so_header_cas (the
-- p_apply_delivery_date cascade). A line with line_delivery_date_overridden =
-- true is HAND-SET and is skipped, keeping its date AND its flag. The item
-- routes set the flag only for a date that differs from the header's
-- (soLineDateOverridden), and backend/scripts/reset-so-line-follower-flags.mjs
-- clears it on lines that were flagged while sitting on the header date.
-- Every other non-frozen line follows exactly as before (date set, flag false).
-- Frozen lines (20260915T1200) are still skipped. Clearing the header date
-- (p_delivery_date NULL, only reachable through Remove Processing Date) still
-- clears every non-frozen line: a line date without a Processing Date is refused
-- (soLineDateRefusal), so a hand-set date cannot survive that clear.
--
-- Signature, grants and every other statement are byte-identical to
-- 20260915T1200_scm_so_header_cas_skip_frozen_lines.sql, so this is a plain
-- CREATE OR REPLACE with no DROP and no overload.
--
-- REVERSAL:
--   Re-run the CREATE OR REPLACE block and REVOKE/GRANT pair of
--   20260915T1200_scm_so_header_cas_skip_frozen_lines.sql (same signature, no
--   DROP needed). Safe on its own: no route depends on this body; reverting only
--   brings back the overwrite of hand-set line dates.

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
  p_company_id bigint DEFAULT NULL,
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
  v_unlinked boolean;
  v_frozen uuid[];
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

  IF (p_apply_warehouse AND p_warehouse_id IS NOT NULL) OR p_apply_delivery_date THEN
    -- so-line-freeze rule 3: a live downstream line naming no SO line.
    v_unlinked := EXISTS (
      SELECT 1 FROM delivery_order_items doi
      JOIN delivery_orders d ON d.id = doi.delivery_order_id
      WHERE d.so_doc_no = p_doc_no
        AND upper(btrim(COALESCE(d.status::text, ''))) <> 'CANCELLED'
        AND doi.so_item_id IS NULL
    ) OR EXISTS (
      SELECT 1 FROM sales_invoice_items sii
      JOIN sales_invoices s ON s.id = sii.sales_invoice_id
      WHERE s.so_doc_no = p_doc_no
        AND upper(btrim(COALESCE(s.status::text, ''))) <> 'CANCELLED'
        AND sii.so_item_id IS NULL AND sii.do_item_id IS NULL
    );
    -- so-line-freeze rule 1: lines a live delivery order / invoice line names.
    SELECT COALESCE(array_agg(DISTINCT x.id), ARRAY[]::uuid[]) INTO v_frozen
    FROM (
      SELECT doi.so_item_id AS id
      FROM delivery_order_items doi
      JOIN delivery_orders d ON d.id = doi.delivery_order_id
      WHERE doi.so_item_id IN (SELECT i.id FROM mfg_sales_order_items i WHERE i.doc_no = p_doc_no)
        AND upper(btrim(COALESCE(d.status::text, ''))) <> 'CANCELLED'
      UNION
      SELECT sii.so_item_id
      FROM sales_invoice_items sii
      JOIN sales_invoices s ON s.id = sii.sales_invoice_id
      WHERE sii.so_item_id IN (SELECT i.id FROM mfg_sales_order_items i WHERE i.doc_no = p_doc_no)
        AND upper(btrim(COALESCE(s.status::text, ''))) <> 'CANCELLED'
    ) x;
  END IF;

  IF p_apply_warehouse AND p_warehouse_id IS NOT NULL AND NOT v_unlinked THEN
    UPDATE mfg_sales_order_items
    SET warehouse_id = p_warehouse_id
    WHERE doc_no = p_doc_no AND cancelled = false
      AND NOT (id = ANY(v_frozen))
      AND (warehouse_id IS NULL
           OR (p_rebind_line_ids IS NOT NULL AND id = ANY(p_rebind_line_ids)));
  END IF;
  IF p_apply_delivery_date AND NOT v_unlinked THEN
    UPDATE mfg_sales_order_items
    SET line_delivery_date = p_delivery_date,
        line_delivery_date_overridden = false
    WHERE doc_no = p_doc_no
      AND NOT (id = ANY(v_frozen))
      AND (p_delivery_date IS NULL OR line_delivery_date_overridden IS NOT TRUE);
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
