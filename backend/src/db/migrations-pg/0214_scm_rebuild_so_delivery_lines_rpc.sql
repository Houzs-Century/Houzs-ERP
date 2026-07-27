-- 0214_scm_rebuild_so_delivery_lines_rpc.sql
-- Atomic SVC-DELIVERY* line rebuild for one SO — duplicate-delivery-fee race fix.
-- Port of 2990 migration 0211 (PR #722, 2026-07-14), which never came across at
-- the cutover: scm's recomputeDeliveryFeeCore still rebuilds the delivery lines
-- as TWO separate statements (DELETE all, then INSERT the recomputed set).
--
-- Bug: every line PATCH on /mfg-sales-orders/:docNo/items/:id ends by calling
-- rederiveDeliveryFee -> recomputeDeliveryFeeCore. The Backend SO Detail Save
-- fires one PATCH per changed line IN PARALLEL, so two rebuilds interleave as
-- delete/delete/insert/insert and the customer is billed the delivery fee TWICE
-- (2990 prod incidents: SO-2606-043 on 2026-06-28, SO-2607-010 on 2026-07-12;
-- both data-repaired 2026-07-14). Running inside the scm atomic-command
-- transaction does NOT close this: under READ COMMITTED the second DELETE never
-- sees the first transaction's freshly INSERTed rows, so both sets survive.
--
-- Fix: collapse the rebuild into ONE function, serialized per doc_no with a
-- transaction-scoped advisory lock. Concurrent rebuilds of the same SO queue;
-- each runs delete -> insert -> header-update atomically, so the last writer
-- leaves exactly one consistent set of delivery lines.
--
-- Column types are NEVER restated here: jsonb_populate_recordset derives them
-- from scm.mfg_sales_order_items itself (the 0147 lesson — a hand-declared type
-- that drifts from the column is a silent break). company_id is read from the
-- SO header rather than trusted from the payload, so a rebuilt line can never
-- land in another company.
--
-- ADDITIVE + IDEMPOTENT — CREATE OR REPLACE FUNCTION only; touches no table.

CREATE OR REPLACE FUNCTION scm.rebuild_mfg_so_delivery_lines(
  p_doc_no             text,
  p_source_doc_no      text,
  p_delivery_fee_centi bigint,
  p_rows               jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_company_id bigint;
BEGIN
  -- Serialize concurrent rebuilds of the SAME SO. hashtextextended gives a
  -- bigint key; the xact lock releases automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended('scm-so-delivery:' || p_doc_no, 0));

  SELECT company_id INTO v_company_id
    FROM scm.mfg_sales_orders
   WHERE doc_no = p_doc_no;
  -- Unknown SO: rebuild nothing rather than orphan lines onto a missing header.
  IF v_company_id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM scm.mfg_sales_order_items
   WHERE doc_no = p_doc_no
     AND item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD');

  INSERT INTO scm.mfg_sales_order_items (
    company_id, doc_no, line_no, line_date, debtor_name, item_group, item_code,
    description, description2, remark, uom, qty,
    unit_price_centi, discount_centi, total_centi, total_inc_centi, balance_centi,
    variants, unit_cost_centi, line_cost_centi, line_margin_centi,
    divan_price_sen, leg_price_sen, special_order_price_sen, custom_specials,
    line_delivery_date, line_delivery_date_overridden, warehouse_id,
    branding, venue, stock_status
  )
  SELECT v_company_id, r.doc_no, r.line_no, r.line_date, r.debtor_name, r.item_group, r.item_code,
         r.description, r.description2, r.remark, r.uom, r.qty,
         r.unit_price_centi, r.discount_centi, r.total_centi, r.total_inc_centi, r.balance_centi,
         r.variants, r.unit_cost_centi, r.line_cost_centi, r.line_margin_centi,
         r.divan_price_sen, r.leg_price_sen, r.special_order_price_sen, r.custom_specials,
         r.line_delivery_date, r.line_delivery_date_overridden, r.warehouse_id,
         r.branding, r.venue, r.stock_status
    FROM jsonb_populate_recordset(NULL::scm.mfg_sales_order_items, COALESCE(p_rows, '[]'::jsonb)) r;

  UPDATE scm.mfg_sales_orders
     SET cross_category_source_doc_no = p_source_doc_no,
         delivery_fee_centi           = p_delivery_fee_centi,
         updated_at                   = now()
   WHERE doc_no = p_doc_no;
END;
$$;

-- service_role ONLY. Unlike scm.settle_pi_paid_centi (which takes ids), this one
-- accepts arbitrary line rows for an arbitrary doc_no, so granting it to anon /
-- authenticated would hand any PostgREST caller a write into any SO.
REVOKE ALL ON FUNCTION scm.rebuild_mfg_so_delivery_lines(text, text, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.rebuild_mfg_so_delivery_lines(text, text, bigint, jsonb)
  TO service_role;

-- PostgREST caches the schema; nudge it so sb.rpc() resolves the new function
-- immediately after the deploy rather than at the next periodic reload.
NOTIFY pgrst, 'reload schema';
