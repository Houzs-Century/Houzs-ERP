-- 0286 — return a shipped DO's units at their ORIGINAL cost, not a blended average.
--
-- REVERSAL: CREATE OR REPLACE FUNCTION scm.fn_return_do_units_at_cost(...) AS
--           <the prior body, from its own earlier migration>. The definition
--           change touches no rows; movements already written by the new body
--           stay as written and are not undone by restoring the old one.
--
-- THE BUG (audit ledger B6; owner decision 2026-08-13 "按原成本退回").
--
-- When an operator REDUCES a line qty on an already-shipped DO,
-- resyncInventoryForDo (routes/delivery-orders-mfg.ts) writes a compensating IN
-- whose cost was the bucket's weighted average:
--
--     unit_cost_sen = round(out_total_cost / out_qty)
--
-- That average blends units that HAVE a cost with units that do not. A "ship
-- anyway" oversell writes an OUT whose FIFO consumer could not cover every unit,
-- so the short units carry no lot consumption and contribute 0 to the total.
-- Return 4 of an OUT of 10 where 6 cost 100 sen and 4 cost nothing and the
-- average hands back 60 sen/unit: too much if the returned units were the
-- uncosted ones, too little if they were the costed ones. Which units come back
-- is NOT knowable from a qty delta, so the average is wrong in one direction or
-- the other every time — and it also MINTS A NEW LOT at that invented cost,
-- which then feeds the next FIFO consumer.
--
-- THE FIX, and why it has to live in SQL.
--
-- The DO CANCEL path already solves this exactly: fn_reverse_do_out (0198) walks
-- inventory_lot_consumptions — the row-level record of which lot paid for which
-- unit — and gives each unit back to ITS OWN lot at ITS OWN cost. There is no
-- average because there is no need to invent one; the answer was recorded when
-- the stock left.
--
-- This function is the PARTIAL form of the same idea: return N units rather than
-- the whole document. It cannot be done from the route, because restoring a lot,
-- shrinking its consumption row, restamping the OUT's COGS and writing the
-- balancing movement have to happen together or not at all — and the SCM route
-- client speaks one statement at a time.
--
-- LIFO, stated rather than implied. Consumptions are unwound newest-first. A qty
-- reduction is an undo, and the thing an operator is undoing is the most recent
-- shipment of that bucket; unwinding oldest-first would return the units that
-- have been settled longest and leave the freshest consumption in place. Nothing
-- in the data says which physical units came back, so the rule is a CHOICE — it
-- is written here so the next reader finds a decision instead of an accident.
--
-- UNCOSTED UNITS COME BACK AT NOTHING, which is the point. When the loop runs out
-- of consumptions before it runs out of qty, the remainder had no cost to begin
-- with (the oversell case). It is returned at 0 and reported in `qty_uncosted` so
-- the caller can say so, rather than smeared into a per-unit figure that would
-- capitalise a cost the company never incurred.
--
-- LOT DOUBLE-COUNT, avoided the way 0198 avoids it. The restored ORIGINAL lots
-- already carry the quantity. The balancing IN exists only so the movement ledger
-- nets correctly, so its trigger-minted lot is closed immediately and its cost
-- stamped 0 — movement ledger via the IN, lot ledger via the restored originals,
-- counted once between them.
--
-- Idempotency is the CALLER's, deliberately. resyncInventoryForDo recomputes its
-- delta from the full movement set on every save, so a re-save with no line
-- change computes delta 0 and never calls this. Giving the function its own
-- "already ran" check would be wrong: unlike a cancel, the same bucket can
-- legitimately be reduced twice.

CREATE OR REPLACE FUNCTION scm.fn_return_do_units_at_cost(
  p_do_id          UUID,
  p_warehouse_id   UUID,
  p_product_code   TEXT,
  p_variant_key    TEXT,
  p_batch_no       TEXT,
  p_qty            INTEGER,
  p_correction_seq INTEGER,
  p_performed_by   UUID,
  p_notes          TEXT
) RETURNS TABLE (
  qty_returned      INTEGER,
  qty_costed        INTEGER,
  qty_uncosted      INTEGER,
  cost_restored_sen BIGINT
)
SET search_path = scm, pg_temp
AS $$
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
     AND m.product_code    = p_product_code
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
       AND mo.product_code    = p_product_code
       AND COALESCE(mo.variant_key, '') = COALESCE(p_variant_key, '')
       AND mo.batch_no IS NOT DISTINCT FROM p_batch_no
     ORDER BY c.created_at DESC, c.id DESC
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
         AND mo.product_code    = p_product_code
         AND COALESCE(mo.variant_key, '') = COALESCE(p_variant_key, '')
         AND mo.batch_no IS NOT DISTINCT FROM p_batch_no
    ) sub
   WHERE m.id = sub.movement_id; -- $

  -- 3. ONE balancing IN so the movement ledger nets to the physical truth. Cost 0
  --    and its minted lot closed: the value went back into the ORIGINAL lots in
  --    step 1, and a second lot here would double-count both stock and cost.
  INSERT INTO scm.inventory_movements (
    movement_type, warehouse_id, product_code, variant_key, product_name,
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
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_return_do_units_at_cost(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, UUID, TEXT) IS
  'Partial form of fn_reverse_do_out (0198) for a line-qty REDUCTION on a shipped DO (audit ledger B6, owner decision 2026-08-13). Returns p_qty units of ONE (warehouse, product, variant, batch) bucket to the lots that actually paid for them, at those lots'' costs, by unwinding inventory_lot_consumptions newest-first; shrinks or deletes each consumption row, restamps the bucket''s OUT movements from the consumptions that survive, and writes ONE balancing IN whose minted lot is immediately closed and whose cost is 0 (the value went back to the original lots). Units with no consumption behind them - the "ship anyway" oversell - return at nothing and are reported in qty_uncosted. Replaces a weighted-average cost that blended costed and uncosted units and minted a lot at the invented figure. NOT idempotent on purpose: the caller recomputes its delta from the full movement set, and unlike a cancel the same bucket may legitimately be reduced twice.';
