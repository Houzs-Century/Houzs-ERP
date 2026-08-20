-- 0314 — The delivery-fee rebuild REFUSES a derivation that was computed from
-- fee lines it no longer agrees with, so a concurrent save cannot revert a
-- typed fee.
--
-- WHY. `rebuild_mfg_so_delivery_lines` takes an advisory xact lock (0214) and
-- that lock does serialise the WRITES. It does not serialise the read that
-- produced them. `recomputeDeliveryFeeCore` reads the SVC-DELIVERY* lines —
-- including the two things the OPERATOR owns on them, the free-form
-- SVC-DELIVERY-ADD gross and the per-line `discount_sen` (#2490) — and only
-- then calls this function, which takes the lock. Read, THEN lock: a textbook
-- lost update.
--
-- It is reachable from one ordinary Save. `runSoLineWrites` fans the dirty-line
-- stage out with `Promise.allSettled` (`so-add-lines.ts:184` -> `:124`; the ADD
-- stage is already sequential for exactly this class of reason, the UPDATE
-- stage is not), and every one of those PATCHes ends in `rederiveDeliveryFee`.
-- So a salesperson who cuts the fee 250 -> 125 AND changes a sofa quantity in
-- the same Save has two rebuilds in flight:
--
--   P_fee  writes discount_sen = 12500, reads the fee lines, derives 125
--   P_sofa reads the fee lines BEFORE that commit, derives 250 (discount 0)
--   P_fee  takes the lock, writes 125
--   P_sofa takes the lock, writes 250  <-- the discount is gone
--
-- The customer was quoted RM 125 and the invoice prints RM 250. The advisory
-- lock made that ordering deterministic rather than preventing it.
--
-- WHAT CHANGES. The caller now passes the operator-owned state it DERIVED FROM,
-- as `p_expect_state`. This function re-reads that same state AFTER the lock
-- and, if it has moved, writes nothing and returns FALSE. The caller re-derives
-- and calls again (`recomputeDeliveryFeeCore`, bounded at 3 attempts). Read
-- becomes lock-read-compare-write, which is what the lock was for.
--
-- The state is keyed by row id, so the comparison is order-free:
--   { "<uuid>": [item_code, qty, unit_price_sen, discount_sen], ... }
-- over the live (non-cancelled) SVC-DELIVERY* lines — the SAME predicate the
-- rebuild itself uses, so the two can never disagree about what a fee line is.
-- Every value is cast to bigint before it becomes jsonb: an integer column
-- rendered as `1` matches JavaScript's `1`, where a numeric `1.00` would not.
--
-- `p_expect_state` DEFAULTS TO NULL, and NULL means "no expectation, do not
-- check" — the pre-0314 behaviour, which is what the repair script
-- (`repair-so-fee-line-integrity.mjs`) and the pg fixtures want: they hold the
-- only writer.
--
-- WHY A BOOLEAN AND NOT AN EXCEPTION. This function is also called from inside
-- `runScmPgCommand`'s transaction (tbc-update / tbc-swap / tbc-swap-sofa). A
-- RAISE there aborts the whole command and 500s a save that only needed to be
-- recomputed. A return value lets the caller retry in place — and in that path
-- the retry is guaranteed to converge, because the advisory xact lock taken on
-- the first call is still held for the rest of that transaction, so nothing can
-- move the state under attempt two.
--
-- The return type is why this is DROP + CREATE rather than CREATE OR REPLACE.
--
-- GRANTS. 0305 re-created this function with DROP + CREATE and did NOT restore
-- 0214's `REVOKE ALL ... FROM PUBLIC` / `GRANT EXECUTE ... TO service_role`, so
-- since 2026-08-18 it has carried the default PUBLIC execute privilege on a
-- function that accepts arbitrary line rows for an arbitrary doc_no. This
-- migration restores the 0214 posture — the state this database ran in from
-- 2026-07-14 to 2026-08-18 — as part of the same DROP + CREATE. That is a
-- repair, not a new restriction; nothing that could execute it before 0214 can
-- execute it now.
--
-- Reversal: DROP FUNCTION scm.rebuild_mfg_so_delivery_lines(text, text, bigint,
--           jsonb, jsonb); then re-run 0310's CREATE OR REPLACE verbatim (the
--           four-argument, RETURNS void body) and re-apply the REVOKE/GRANT
--           pair below against the four-argument signature. No schema change —
--           this replaces a function only, so the reversal is complete and
--           carries no data migration.

SET search_path TO scm, public;

DROP FUNCTION IF EXISTS scm.rebuild_mfg_so_delivery_lines(p_doc_no text, p_source_doc_no text, p_delivery_fee_sen bigint, p_rows jsonb);

CREATE FUNCTION scm.rebuild_mfg_so_delivery_lines(p_doc_no text, p_source_doc_no text, p_delivery_fee_sen bigint, p_rows jsonb, p_expect_state jsonb DEFAULT NULL)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_company_id bigint;
  v_state      jsonb;
BEGIN
  -- Serialize concurrent rebuilds of the SAME SO. hashtextextended gives a
  -- bigint key; the xact lock releases automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended('scm-so-delivery:' || p_doc_no, 0));

  /* 0. AGREE. Everything below derives from fee lines the CALLER read before
     the lock above existed for it. Re-read the operator-owned half here, under
     the lock, and refuse rather than overwrite a figure this derivation never
     saw. NULL means the caller claims no expectation (see the header). */
  IF p_expect_state IS NOT NULL THEN
    SELECT COALESCE(jsonb_object_agg(
             x.id::text,
             jsonb_build_array(
               x.item_code,
               COALESCE(x.qty, 0)::bigint,
               COALESCE(x.unit_price_sen, 0)::bigint,
               COALESCE(x.discount_sen, 0)::bigint)), '{}'::jsonb)
      INTO v_state
      FROM scm.mfg_sales_order_items x
     WHERE x.doc_no = p_doc_no
       AND x.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(x.cancelled, false) = false;
    IF v_state IS DISTINCT FROM p_expect_state THEN
      RETURN false;
    END IF;
  END IF;

  SELECT company_id INTO v_company_id
    FROM scm.mfg_sales_orders
   WHERE doc_no = p_doc_no;
  -- Unknown SO: rebuild nothing rather than orphan lines onto a missing header.
  IF v_company_id IS NULL THEN
    RETURN true;
  END IF;

  -- 1. REUSE. Every incoming row that has a live counterpart of the same
  --    item_code updates it in place, so the row id — and any DO line pointing
  --    at it — survives the rebuild.
  WITH incoming AS (
    SELECT p.*, row_number() OVER (PARTITION BY p.item_code ORDER BY e.ord) AS seq
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(val, ord)
      CROSS JOIN LATERAL jsonb_populate_record(NULL::scm.mfg_sales_order_items, e.val) AS p
  ), live AS (
    SELECT x.id, x.item_code,
           row_number() OVER (PARTITION BY x.item_code ORDER BY x.id) AS seq
      FROM scm.mfg_sales_order_items x
     WHERE x.doc_no = p_doc_no
       AND x.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(x.cancelled, false) = false
  )
  UPDATE scm.mfg_sales_order_items t
     SET line_no                       = i.line_no,
         line_date                     = i.line_date,
         debtor_name                   = i.debtor_name,
         item_group                    = i.item_group,
         description                   = i.description,
         description2                  = i.description2,
         remark                        = i.remark,
         uom                           = i.uom,
         qty                           = i.qty,
         unit_price_sen                = i.unit_price_sen,
         discount_sen                  = i.discount_sen,
         total_sen                     = i.total_sen,
         total_inc_sen                 = i.total_inc_sen,
         balance_sen                   = i.balance_sen,
         variants                      = i.variants,
         unit_cost_sen                 = i.unit_cost_sen,
         line_cost_sen                 = i.line_cost_sen,
         line_margin_sen               = i.line_margin_sen,
         divan_price_sen               = i.divan_price_sen,
         leg_price_sen                 = i.leg_price_sen,
         special_order_price_sen       = i.special_order_price_sen,
         custom_specials               = i.custom_specials,
         line_delivery_date            = i.line_delivery_date,
         line_delivery_date_overridden = i.line_delivery_date_overridden,
         warehouse_id                  = i.warehouse_id,
         branding                      = i.branding,
         venue                         = i.venue,
         stock_status                  = i.stock_status
    FROM live l
    JOIN incoming i ON i.item_code = l.item_code AND i.seq = l.seq
   WHERE t.id = l.id;

  -- 2. RETIRE. A fee component that no longer exists — and every cancelled
  --    SVC-DELIVERY* line, which never matches — goes, exactly as before. This
  --    is the one remaining path that can blank a DO link, and it should: the
  --    line it pointed at is genuinely gone.
  WITH incoming AS (
    SELECT p.item_code, row_number() OVER (PARTITION BY p.item_code ORDER BY e.ord) AS seq
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(val, ord)
      CROSS JOIN LATERAL jsonb_populate_record(NULL::scm.mfg_sales_order_items, e.val) AS p
  ), live AS (
    SELECT x.id, x.item_code,
           row_number() OVER (PARTITION BY x.item_code ORDER BY x.id) AS seq
      FROM scm.mfg_sales_order_items x
     WHERE x.doc_no = p_doc_no
       AND x.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(x.cancelled, false) = false
  ), keep AS (
    SELECT l.id FROM live l JOIN incoming i ON i.item_code = l.item_code AND i.seq = l.seq
  )
  DELETE FROM scm.mfg_sales_order_items t
   WHERE t.doc_no = p_doc_no
     AND t.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
     AND NOT EXISTS (SELECT 1 FROM keep k WHERE k.id = t.id);

  -- 3. ADD. Only the components with no line to reuse. `live` is re-read after
  --    step 2, which removed only unmatched rows from the tail of each
  --    item_code group, so the surviving sequence numbers are the ones step 1
  --    matched on.
  WITH incoming AS (
    SELECT p.*, row_number() OVER (PARTITION BY p.item_code ORDER BY e.ord) AS seq
      FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(val, ord)
      CROSS JOIN LATERAL jsonb_populate_record(NULL::scm.mfg_sales_order_items, e.val) AS p
  ), live AS (
    SELECT x.id, x.item_code,
           row_number() OVER (PARTITION BY x.item_code ORDER BY x.id) AS seq
      FROM scm.mfg_sales_order_items x
     WHERE x.doc_no = p_doc_no
       AND x.item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD')
       AND COALESCE(x.cancelled, false) = false
  )
  INSERT INTO scm.mfg_sales_order_items (
    company_id, doc_no, line_no, line_date, debtor_name, item_group, item_code,
    description, description2, remark, uom, qty,
    unit_price_sen, discount_sen, total_sen, total_inc_sen, balance_sen,
    variants, unit_cost_sen, line_cost_sen, line_margin_sen,
    divan_price_sen, leg_price_sen, special_order_price_sen, custom_specials,
    line_delivery_date, line_delivery_date_overridden, warehouse_id,
    branding, venue, stock_status
  )
  SELECT v_company_id, i.doc_no, i.line_no, i.line_date, i.debtor_name, i.item_group, i.item_code,
         i.description, i.description2, i.remark, i.uom, i.qty,
         i.unit_price_sen, i.discount_sen, i.total_sen, i.total_inc_sen, i.balance_sen,
         i.variants, i.unit_cost_sen, i.line_cost_sen, i.line_margin_sen,
         i.divan_price_sen, i.leg_price_sen, i.special_order_price_sen, i.custom_specials,
         i.line_delivery_date, i.line_delivery_date_overridden, i.warehouse_id,
         i.branding, i.venue, i.stock_status
    FROM incoming i
   WHERE NOT EXISTS (
     SELECT 1 FROM live l WHERE l.item_code = i.item_code AND l.seq = i.seq
   );

  UPDATE scm.mfg_sales_orders
     SET cross_category_source_doc_no = p_source_doc_no,
         delivery_fee_sen             = p_delivery_fee_sen,
         updated_at                   = now()
   WHERE doc_no = p_doc_no;

  RETURN true;
END;
$function$;

-- service_role ONLY (0214's posture, lost by 0305's DROP + CREATE). This
-- function accepts arbitrary line rows for an arbitrary doc_no, so the default
-- PUBLIC execute privilege would hand any PostgREST caller a write into any SO.
REVOKE ALL ON FUNCTION scm.rebuild_mfg_so_delivery_lines(text, text, bigint, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scm.rebuild_mfg_so_delivery_lines(text, text, bigint, jsonb, jsonb)
  TO service_role;

COMMENT ON FUNCTION scm.rebuild_mfg_so_delivery_lines(text, text, bigint, jsonb, jsonb) IS
  'Re-derives the SVC-DELIVERY* lines of one SO from p_rows. Reuses existing '
  'live lines in place (0310) so delivery_order_items.so_item_id survives a '
  'fee change; deletes only components that no longer exist. Serialised per '
  'doc_no by an advisory xact lock (0214). Returns FALSE without writing when '
  'p_expect_state (the operator-owned fee state the caller derived from) no '
  'longer matches what is there under that lock (0314) — the caller re-derives '
  'and calls again. p_expect_state NULL disables the check.';

-- PostgREST caches the schema; nudge it so sb.rpc() resolves the new signature
-- immediately after the deploy rather than at the next periodic reload.
NOTIFY pgrst, 'reload schema';
