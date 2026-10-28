-- 0172_scm_so_edit_lease_and_followers.sql (Postgres)
-- Rollout dependency: apply idempotency Phase 1 (0158), allow its soak period,
-- then apply Phase 2 (0159), and only then apply this migration before the
-- Sales Order lease-aware application code is deployed.
-- Durable, expiring edit lease for a multi-request Sales Order save. The
-- header CAS acquires it; every line add/update/delete must present the same
-- token; the final header/release clears it. This closes the gap where a stale
-- composite editor could persist lines before discovering a header conflict.
ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS edit_lease_token text,
  ADD COLUMN IF NOT EXISTS edit_lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_mfg_sales_orders_edit_lease_expiry
  ON scm.mfg_sales_orders (edit_lease_expires_at)
  WHERE edit_lease_token IS NOT NULL;

-- Header followers are one version-bound transaction. The row lock makes the
-- version proof and every follower write indivisible: a later header writer
-- waits, then advances version after these writes; an already-newer version
-- returns applied=false and no customer/line row is touched.
CREATE OR REPLACE FUNCTION scm.apply_so_header_followers(p_doc_no text, p_version integer, p_recustomer boolean DEFAULT false, p_customer_name text DEFAULT NULL, p_customer_phone text DEFAULT NULL, p_customer_email text DEFAULT NULL, p_apply_warehouse boolean DEFAULT false, p_warehouse_id uuid DEFAULT NULL, p_apply_delivery_date boolean DEFAULT false, p_delivery_date date DEFAULT NULL) RETURNS TABLE(applied boolean, resolved_customer_id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = scm, pg_temp AS $$ DECLARE v_version integer; v_customer_id uuid; BEGIN SELECT version INTO v_version FROM mfg_sales_orders WHERE doc_no = p_doc_no FOR UPDATE; IF NOT FOUND OR v_version <> p_version THEN RETURN QUERY SELECT false, NULL::uuid; RETURN; END IF; IF p_recustomer AND NULLIF(btrim(p_customer_name), '') IS NOT NULL AND NULLIF(btrim(p_customer_phone), '') IS NOT NULL THEN v_customer_id := upsert_customer_by_name_phone(p_customer_name, p_customer_phone, p_customer_email); UPDATE mfg_sales_orders SET customer_id = v_customer_id WHERE doc_no = p_doc_no AND version = p_version; UPDATE pwp_codes SET customer_id = v_customer_id, updated_at = now() WHERE source_doc_no = p_doc_no; END IF; IF p_apply_warehouse AND p_warehouse_id IS NOT NULL THEN UPDATE mfg_sales_order_items SET warehouse_id = p_warehouse_id WHERE doc_no = p_doc_no AND cancelled = false AND warehouse_id IS NULL; END IF; IF p_apply_delivery_date THEN UPDATE mfg_sales_order_items SET line_delivery_date = p_delivery_date, line_delivery_date_overridden = false WHERE doc_no = p_doc_no; END IF; RETURN QUERY SELECT true, v_customer_id; END; $$;

-- SECURITY DEFINER must never be callable from browser-facing database roles.
-- Only the Worker service client invokes this after its normal authorization.
REVOKE ALL ON FUNCTION scm.apply_so_header_followers(text, integer, boolean, text, text, text, boolean, uuid, boolean, date)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.apply_so_header_followers(text, integer, boolean, text, text, text, boolean, uuid, boolean, date)
  TO service_role;

NOTIFY pgrst, 'reload schema';
