-- 20261026T1600_scm_retrocost_no_zero_overwrite.sql
-- REVERSAL: re-run the scm.fn_reconcile_uncosted_out body from
--   0307_item_code_unify.sql. GRANTS: none to re-apply — CREATE OR REPLACE keeps
--   the function's existing grants.
--
-- THE BUG. For every short OUT the function re-stamped the movement's
-- total_cost_sen to SUM(its consumption rows) — even when it found no lot and
-- added nothing. An OUT that carried a cost with no (or too few) consumption
-- rows lost that cost: the retro-cost DRY-RUN of 2026-10-26 showed 46 company-2
-- sofa OUTs dropping about RM42,809 with 0 units reconciled.
--
-- THE FIX. Add only what this call consumed onto the OUT's existing cost, and
-- only when it consumed something. This is what planUncostedRetrocost already
-- models (newTotalCostSen = alreadyCostedSen + retroCostSen).
CREATE OR REPLACE FUNCTION scm.fn_reconcile_uncosted_out(p_warehouse_id uuid, p_product_code text, p_variant_key text, p_before_ts timestamp with time zone, p_created_by uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_out       RECORD;
  v_lot       RECORD;
  v_already   INTEGER;
  v_short     INTEGER;
  v_take      INTEGER;
  v_consumed  INTEGER := 0;
  v_added_sen BIGINT;
BEGIN
  FOR v_out IN
    SELECT m.id, m.qty, m.company_id,
           m.source_doc_type, m.source_doc_id, m.source_doc_no
      FROM scm.inventory_movements m
     WHERE m.movement_type   = 'OUT'
       AND m.warehouse_id     = p_warehouse_id
       AND m.item_code     = p_product_code
       AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
       AND m.source_doc_type  = 'DO'
       AND m.created_at       < p_before_ts
       AND EXISTS (
         SELECT 1 FROM scm.delivery_orders d
          WHERE d.id = m.source_doc_id
            AND COALESCE(d.is_dropship, FALSE) = FALSE
            AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
       )
       /* The mirror exclusion — STRICT-BATCH LINES ONLY (see the header). A
          committed SOFA OUT belongs to the batched reconcile, because costing it
          from an arbitrary lot means another dye lot. A committed MATTRESS OUT
          has no dye lot to protect and MUST stay repairable here, or a cancelled
          / re-raised PO would strand its COGS at RM0 for good — which is what
          this migration exists to stop, not to cause. */
       AND NOT (
         m.batch_no IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM scm.delivery_order_items di
            WHERE di.delivery_order_id     = m.source_doc_id
              AND di.committed_po_batch_no = m.batch_no
              AND di.item_code             = m.item_code
              AND COALESCE(di.committed_variant_key, '') = COALESCE(m.variant_key, '')
              AND di.committed_batch_strict = TRUE
         )
       )
     ORDER BY m.created_at ASC, m.id ASC
     FOR UPDATE OF m
  LOOP
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id;
    v_short := ABS(v_out.qty) - v_already;
    CONTINUE WHEN v_short <= 0;
    v_added_sen := 0;
    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen, company_id
        FROM scm.inventory_lots
       WHERE warehouse_id = p_warehouse_id
         AND item_code = p_product_code
         AND COALESCE(variant_key, '') = COALESCE(p_variant_key, '')
         AND company_id   = v_out.company_id
         AND qty_remaining > 0
       ORDER BY received_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_short <= 0;
      v_take := LEAST(v_lot.qty_remaining, v_short);

      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining - v_take
       WHERE id = v_lot.id;

      INSERT INTO scm.inventory_lot_consumptions (
        lot_id, warehouse_id, item_code, variant_key,
        qty_consumed, unit_cost_sen, total_cost_sen,
        source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
        company_id
      ) VALUES (
        v_lot.id, p_warehouse_id, p_product_code, COALESCE(p_variant_key, ''),
        v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
        v_out.source_doc_type, v_out.source_doc_id, v_out.source_doc_no,
        v_out.id, p_created_by, v_lot.company_id
      );

      v_short    := v_short - v_take;
      v_consumed := v_consumed + v_take;
      v_added_sen := v_added_sen + v_take::BIGINT * COALESCE(v_lot.unit_cost_sen, 0);
    END LOOP;

    IF v_added_sen > 0 THEN
      UPDATE scm.inventory_movements m
         SET total_cost_sen = COALESCE(m.total_cost_sen, 0) + v_added_sen,
             unit_cost_sen  = CASE WHEN ABS(m.qty) > 0
                                   THEN (COALESCE(m.total_cost_sen, 0) + v_added_sen) / ABS(m.qty) ELSE 0 END
       WHERE m.id = v_out.id;
    END IF;
  END LOOP;

  RETURN v_consumed;
END;
$function$;
