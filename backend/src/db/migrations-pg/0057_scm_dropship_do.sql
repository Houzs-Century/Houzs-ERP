-- ----------------------------------------------------------------------------
-- 0057 — Sofa drop-ship / supplier-direct DO (port of 2990 mig 0204, 07c45728).
--
-- THE NEED
--   The warehouse holds no stock; the supplier ships the sofa straight to the
--   customer. The operator must open a DO now -- but the sofa whole-set rule
--   (findSofaLinesWithoutCompleteBatch, "Type A") blocks it because no single
--   received batch can fulfil the set. Drop-ship waives that ONE block: the
--   OUT posts against the EXPECTED production batch (= the bound PO number)
--   even though nothing is received yet, so stock goes NEGATIVE under that
--   batch. When the PO's GRN later posts an IN for the same batch, the two NET
--   inside scm.inventory_balances (SUM(IN-OUT), batch-agnostic) automatically.
--
-- THE GAP THIS MIGRATION CLOSES
--   A drop-ship OUT consumes NO lot -- at OUT time the batch has no open lot,
--   so fn_consume_fifo_batch reports the whole qty as short and writes ZERO
--   inventory_lot_consumptions rows. When the GRN later creates a FULL positive
--   lot for that batch, the sofa coverage helper (sofa-set-coverage helpers,
--   reading v_inventory_lots_open.qty_remaining) would DOUBLE-COUNT the units
--   already shipped on the drop-ship DO -- making the set look ready again.
--
--   fn_reconcile_dropship_batch closes it: at GRN post (called from grns.ts
--   right after the IN movements write) it consumes the outstanding drop-ship
--   SHORTFALL from the freshly-received lots so qty_remaining (hence coverage
--   AND valuation) reflects only the truly-available remainder.
--
--   LEDGER-DRIVEN + IDEMPOTENT -- shortfall is recomputed from the ledger on
--   every call, NOT a consume-once flag. A second GRN for the same batch
--   recomputes shortfall = 0 and consumes nothing extra.
--
--   COGS: the reconcile consumes the ARRIVING lot at its real landed cost (the
--   same FIFO cost a normal short-ship would pick up once stock arrives) and
--   re-stamps the drop-ship OUT movement's total_cost_sen + unit_cost_sen so
--   restampDoActualCost (recost cascade) re-derives the DO's COGS from it. The
--   original drop-ship OUT was stamped 0-cost at ship time; the follow-up
--   restamp lives in the GRN post path (delegated by reconcileDropshipBatches).
--
-- NOTE ON is_dropship: a flag column on scm.delivery_orders drives ONLY the UI
--   badge ("Drop-ship - batch not received"). The reconcile itself is fully
--   ledger-driven and does NOT read it, so a missed flag can never corrupt
--   inventory.
--
-- HOUZS CONVENTIONS
--   schema-qualified (scm.*); no inner BEGIN/COMMIT (pg-migrate owns the txn);
--   IF NOT EXISTS for additive safety; SET search_path = scm, public so the
--   function body's unqualified table/view refs resolve to scm.* (mirrors the
--   FIFO trigger). The function body uses trailing line-comments after every
--   internal ';' to prevent pg-migrate's /;\s*\n/ splitter from carving the
--   PL/pgSQL body into broken pieces.
--
-- DEPENDENCIES (already present in scm baseline)
--   scm.inventory_movements, scm.inventory_lots (batch_no col),
--   scm.inventory_lot_consumptions, scm.purchase_order_items.so_item_id
--   (mig 0098 port), scm.purchase_orders.supplier_delivery_date_2..4 (mig 0026).
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1. UI badge flag (additive, idempotent).
ALTER TABLE scm.delivery_orders
  ADD COLUMN IF NOT EXISTS is_dropship BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN scm.delivery_orders.is_dropship IS
  'TRUE when any sofa line on this DO was shipped as a supplier-direct drop-ship: the warehouse had no received batch, so the OUT posted against the EXPECTED production batch (bound PO number) and stock went negative until the PO''s GRN arrives and nets it out. Drives the "Drop-ship - batch not received" UI badge ONLY -- inventory reconciliation is ledger-driven (fn_reconcile_dropship_batch) and never reads this flag.';

-- 2. Receipt-time drop-ship reconcile (the crux).
-- For ONE (warehouse, product, variant, batch) bucket, consume each drop-ship
-- OUT movement's outstanding (uncosted) qty from the batch's freshly-received
-- open lots (FIFO, at the lot's real cost), writing inventory_lot_consumptions
-- linked to that OUT's movement_id + DO source-doc and re-stamping the OUT's
-- total/unit cost. Idempotent + ledger-driven: an OUT whose consumptions
-- already cover its qty is skipped, so a second GRN consumes nothing. The
-- function body's internal ';' chars are each followed by a trailing '-- $'
-- marker so the pg-migrate splitter (/;\s*\n/) cannot carve the body apart.
CREATE OR REPLACE FUNCTION scm.fn_reconcile_dropship_batch(
  p_warehouse_id  UUID,
  p_product_code  TEXT,
  p_variant_key   TEXT,
  p_batch_no      TEXT,
  p_created_by    UUID
) RETURNS INTEGER AS $$
DECLARE
  v_out         RECORD; -- $
  v_lot         RECORD; -- $
  v_already     INTEGER; -- $
  v_short       INTEGER; -- $
  v_take        INTEGER; -- $
  v_consumed    INTEGER := 0; -- $
BEGIN
  IF p_batch_no IS NULL THEN
    RETURN 0; -- $
  END IF; -- $

  FOR v_out IN
    SELECT id, qty, source_doc_type, source_doc_id, source_doc_no
      FROM scm.inventory_movements
     WHERE movement_type = 'OUT'
       AND warehouse_id  = p_warehouse_id
       AND product_code  = p_product_code
       AND COALESCE(variant_key, '') = COALESCE(p_variant_key, '')
       AND batch_no      = p_batch_no
     ORDER BY created_at ASC, id ASC
     FOR UPDATE
  LOOP
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id; -- $
    v_short := ABS(v_out.qty) - v_already; -- $
    CONTINUE WHEN v_short <= 0; -- $

    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen
        FROM scm.inventory_lots
       WHERE warehouse_id = p_warehouse_id
         AND product_code = p_product_code
         AND COALESCE(variant_key, '') = COALESCE(p_variant_key, '')
         AND batch_no     = p_batch_no
         AND qty_remaining > 0
       ORDER BY received_at ASC, id ASC
       FOR UPDATE
    LOOP
      EXIT WHEN v_short <= 0; -- $
      v_take := LEAST(v_lot.qty_remaining, v_short); -- $

      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining - v_take
       WHERE id = v_lot.id; -- $

      INSERT INTO scm.inventory_lot_consumptions (
        lot_id, warehouse_id, product_code, variant_key,
        qty_consumed, unit_cost_sen, total_cost_sen,
        source_doc_type, source_doc_id, source_doc_no, movement_id, created_by
      ) VALUES (
        v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
        v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
        v_out.source_doc_type, v_out.source_doc_id, v_out.source_doc_no, v_out.id, p_created_by
      ); -- $

      v_short    := v_short - v_take; -- $
      v_consumed := v_consumed + v_take; -- $
    END LOOP; -- $

    UPDATE scm.inventory_movements m
       SET total_cost_sen = sub.total_cost,
           unit_cost_sen  = CASE WHEN ABS(m.qty) > 0 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
      FROM (
        SELECT COALESCE(SUM(total_cost_sen), 0) AS total_cost
          FROM scm.inventory_lot_consumptions
         WHERE movement_id = v_out.id
      ) sub
     WHERE m.id = v_out.id; -- $
  END LOOP; -- $

  RETURN v_consumed; -- $
END; -- $
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_reconcile_dropship_batch(UUID, TEXT, TEXT, TEXT, UUID) IS
  'Receipt-time drop-ship reconcile (migration 0057, port of 2990 0204). For ONE (warehouse, product, variant, batch) bucket, consumes each drop-ship OUT movement''s outstanding (uncosted) qty from the batch''s newly-received open lots (FIFO, at the lot''s real cost), writing inventory_lot_consumptions linked to that OUT''s movement_id + DO source-doc and re-stamping the OUT''s total/unit cost. Idempotent + ledger-driven: an OUT whose consumptions already cover its qty is skipped, so a second GRN consumes nothing. COGS flows through the existing recost -> restampDoActualCost cascade. Called from the GRN post path after the IN movements write; affected DO lines should be restamped after.';
