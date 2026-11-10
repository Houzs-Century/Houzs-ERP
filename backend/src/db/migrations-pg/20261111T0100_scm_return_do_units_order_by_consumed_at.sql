-- 20261111T0100_scm_return_do_units_order_by_consumed_at.sql
--
-- scm.fn_return_do_units_at_cost has never run to completion in production.
-- Its consumption walk ordered by c.created_at, and scm.inventory_lot_consumptions
-- has no such column: it is consumed_at (information_schema read live on
-- 2026-11-10, Actions run 42778085508). plpgsql checks column names only when the
-- statement runs, so the migration that created the function (0291) applied
-- cleanly and every call since has raised 42703.
--
-- What that cost. resyncInventoryForDo (edit a shipped DO line: lower its qty,
-- delete it, or change its spec) calls this function to give units back to the
-- lots that paid for them. On the error it fell back to a plain IN, and the FIFO
-- trigger turned that IN into a NEW lot whose source is the DO, with no GRN and
-- no PO. The original lot stayed consumed. Seen on 2990-DO-2611-016 and
-- 2990-DO-2611-018 (CODY-(K), KL WAREHOUSE): the planner for the DO's source-PO
-- stamp found a dispatch rack but no PO.
--
-- The change: ORDER BY c.consumed_at instead of c.created_at. Nothing else in the
-- body changes; the text below is 0307's definition with that one line edited.
-- The parameter is still named p_product_code: CREATE OR REPLACE cannot rename a
-- parameter, and the route now sends that name (it had sent p_item_code since
-- #2447, a second reason no call ever reached the body).
--
-- Safe: CREATE OR REPLACE of one function. No table, row, grant or trigger changes.
--
-- REVERSAL: re-run the CREATE OR REPLACE FUNCTION scm.fn_return_do_units_at_cost
--   block from 0307_item_code_unify.sql. That restores the broken ORDER BY;
--   movements written by this body stay as written.
-- Verified against: production catalog via backend/scripts/check-item-lot-ledger.mjs
--   (column list of scm.inventory_lot_consumptions and this function's signature).

CREATE OR REPLACE FUNCTION scm.fn_return_do_units_at_cost(p_do_id uuid, p_warehouse_id uuid, p_product_code text, p_variant_key text, p_batch_no text, p_qty integer, p_correction_seq integer, p_performed_by uuid, p_notes text)
 RETURNS TABLE(qty_returned integer, qty_costed integer, qty_uncosted integer, cost_restored_sen bigint)
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_con       RECORD; -- $
  v_need      INTEGER := p_qty; -- $
  v_take      INTEGER; -- $
  v_costed    INTEGER := 0; -- $
  v_cost      BIGINT  := 0; -- $
  v_in_id     UUID; -- $
  v_doc_no    TEXT; -- $
  v_name      TEXT; -- $
  v_company   BIGINT; -- $
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN
    RETURN QUERY SELECT 0, 0, 0, 0::BIGINT; -- $
    RETURN; -- $
  END IF; -- $

  -- Bucket identity for the balancing row. Read from the DO's own movements so
  -- the IN matches the OUT it compensates (name, doc number, company) instead of
  -- being re-derived from the document and drifting.
  SELECT MAX(m.source_doc_no), MAX(m.product_name), MAX(m.company_id)
    INTO v_doc_no, v_name, v_company
    FROM scm.inventory_movements m
   WHERE m.source_doc_type = 'DO'
     AND m.source_doc_id   = p_do_id
     AND m.warehouse_id    = p_warehouse_id
     AND m.item_code    = p_product_code
     AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
     AND m.batch_no IS NOT DISTINCT FROM p_batch_no; -- $

  -- 1. Unwind this bucket's lot consumptions, newest first, up to p_qty units.
  --    Each unit goes back to the lot that paid for it, at that lot's cost.
  FOR v_con IN
    SELECT c.id, c.lot_id, c.qty_consumed, c.unit_cost_sen
      FROM scm.inventory_lot_consumptions c
      JOIN scm.inventory_movements mo ON mo.id = c.movement_id
     WHERE mo.source_doc_type = 'DO'
       AND mo.source_doc_id   = p_do_id
       AND mo.movement_type   = 'OUT'
       AND mo.warehouse_id    = p_warehouse_id
       AND mo.item_code    = p_product_code
       AND COALESCE(mo.variant_key, '') = COALESCE(p_variant_key, '')
       AND mo.batch_no IS NOT DISTINCT FROM p_batch_no
     ORDER BY c.consumed_at DESC, c.id DESC
     FOR UPDATE OF c
  LOOP
    EXIT WHEN v_need <= 0; -- $
    v_take := LEAST(v_need, v_con.qty_consumed); -- $
    IF v_take <= 0 THEN
      CONTINUE; -- $
    END IF; -- $

    UPDATE scm.inventory_lots
       SET qty_remaining = qty_remaining + v_take
     WHERE id = v_con.lot_id; -- $

    IF v_take >= v_con.qty_consumed THEN
      -- Wholly returned: the consumption never happened. Deleting rather than
      -- zeroing matches fn_reverse_do_out — a 0-qty consumption row still reads
      -- as "this DO consumed this lot" to every report that joins on it.
      DELETE FROM scm.inventory_lot_consumptions WHERE id = v_con.id; -- $
    ELSE
      UPDATE scm.inventory_lot_consumptions
         SET qty_consumed  = qty_consumed - v_take,
             total_cost_sen = (qty_consumed - v_take) * COALESCE(unit_cost_sen, 0)
       WHERE id = v_con.id; -- $
    END IF; -- $

    v_costed := v_costed + v_take; -- $
    v_cost   := v_cost + (v_take::BIGINT * COALESCE(v_con.unit_cost_sen, 0)); -- $
    v_need   := v_need - v_take; -- $
  END LOOP; -- $

  -- 2. Restamp every OUT in the bucket from the consumptions that SURVIVED, so
  --    the shipment's COGS is what is still shipped. Same shape as 0088's
  --    re-stamp. An OUT whose consumptions are all gone lands on 0, correctly.
  UPDATE scm.inventory_movements m
     SET total_cost_sen = sub.total_cost,
         unit_cost_sen  = CASE WHEN ABS(m.qty) > 0 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
    FROM (
      SELECT mo.id AS movement_id,
             COALESCE((SELECT SUM(c.total_cost_sen)
                         FROM scm.inventory_lot_consumptions c
                        WHERE c.movement_id = mo.id), 0) AS total_cost
        FROM scm.inventory_movements mo
       WHERE mo.source_doc_type = 'DO'
         AND mo.source_doc_id   = p_do_id
         AND mo.movement_type   = 'OUT'
         AND mo.warehouse_id    = p_warehouse_id
         AND mo.item_code    = p_product_code
         AND COALESCE(mo.variant_key, '') = COALESCE(p_variant_key, '')
         AND mo.batch_no IS NOT DISTINCT FROM p_batch_no
    ) sub
   WHERE m.id = sub.movement_id; -- $

  -- 3. ONE balancing IN so the movement ledger nets to the physical truth. Cost 0
  --    and its minted lot closed: the value went back into the ORIGINAL lots in
  --    step 1, and a second lot here would double-count both stock and cost.
  INSERT INTO scm.inventory_movements (
    movement_type, warehouse_id, item_code, variant_key, product_name,
    qty, batch_no, source_doc_type, source_doc_id, source_doc_no,
    correction_seq, performed_by, notes, company_id
  ) VALUES (
    'IN', p_warehouse_id, p_product_code, COALESCE(p_variant_key, ''), v_name,
    p_qty, p_batch_no, 'DO', p_do_id, v_doc_no,
    p_correction_seq, p_performed_by,
    COALESCE(p_notes, 'Resync: line qty reduced / line deleted (shipped DO).')
      || ' Original lots restored at original cost'
      || CASE WHEN v_need > 0
              THEN ' (' || v_need || ' unit(s) had no cost to return - uncosted at shipment).'
              ELSE '.' END,
    v_company
  ) RETURNING id INTO v_in_id; -- $

  UPDATE scm.inventory_lots SET qty_remaining = 0 WHERE movement_id = v_in_id; -- $
  UPDATE scm.inventory_movements SET total_cost_sen = 0, unit_cost_sen = 0 WHERE id = v_in_id; -- $

  RETURN QUERY SELECT p_qty, v_costed, v_need, v_cost; -- $
END; -- $
$function$;
