-- ----------------------------------------------------------------------------
-- 0088 — Drop-ship hardening (2990 audit 2026-06-26, fixes C2 / H2 / H4).
--
-- Companion to the route-side hardening in delivery-orders-mfg.ts /
-- mfg-purchase-orders.ts / dropship-batch.ts (C1 / C3 / H1 / H3). Three parts:
--
-- 1. fn_reconcile_dropship_batch (REPLACE, from 0057) — H2 + the C2 twist.
--    The OUT loop previously selected ANY OUT movement in the (warehouse,
--    product, variant, batch) bucket. Two holes:
--      a. TOCTOU — two concurrent NORMAL sofa DOs on the same batch can both
--         pass the ship gate, the 2nd short-ships, and a later unrelated GRN
--         for that batch "reconciles" the uncosted normal OUT, stealing another
--         SO's coverage.
--      b. A CANCELLED drop-ship DO's OUT could be "costed" by a later real GRN,
--         consuming the real lot for a shipment that never happened.
--    Fix: scope the OUT loop to GENUINE drop-ship rows — source_doc_type='DO'
--    AND the source DO is is_dropship = TRUE AND not CANCELLED.
--
-- 2. fn_reverse_dropship_do_out (NEW) — C2 + H4. Cancel-path reversal for a
--    drop-ship DO's BATCHED buckets, called from reverseInventoryForDo (route)
--    instead of the batched reversing IN it used to write:
--      C2 (cancel BEFORE receive): the old batched IN made the FIFO trigger
--         mint a phantom open lot (qty N, batch PO-X, cost 0) for stock that
--         was never received — phantom sofa coverage forever.
--      H4 (cancel AFTER receive): the old batched IN left the reconcile's
--         inventory_lot_consumptions rows orphaned on a cancelled DO
--         (overstated COGS) plus a synthetic lot that recost.ts never re-costs.
--    This function instead, per batched bucket of the DO:
--      a. restores every consumption linked to the DO's OUT movements
--         (inventory_lots.qty_remaining += qty_consumed, row deleted) — the
--         original received lot comes back instead of a synthetic one;
--      b. zeroes the OUT movements' cost stamps (their consumptions are gone);
--      c. closes any still-intact lot minted by this DO's OWN delta-IN
--         movements (resync qty-decrease before receipt) — phantom by
--         construction;
--      d. writes ONE balancing ADJUSTMENT (+net_out) per bucket so
--         inventory_balances nets to the physical truth, then immediately
--         closes the lot the ADJUSTMENT trigger branch opened (the goods were
--         either restored to their original lots in (a), or never physically
--         received at all).
--    Idempotent: an existing ADJUSTMENT-sourced movement for the DO means the
--    reversal already ran — returns 0 (mirrors the route-side guard).
--
-- 3. fn_inventory_movement_fifo (REPLACE, from scripts/scm-schema/
--    inventory-fifo-trigger.sql) — the ADJUSTMENT qty>0 branch's lot INSERT
--    was missing company_id. scm.inventory_lots.company_id is NOT NULL since
--    migration 0083, so every positive ADJUSTMENT (all DO-cancel add-backs,
--    including the ones part 2 writes) would violate the constraint and roll
--    the movement back. Carries NEW.company_id now, same as the IN branch.
--    This also finally puts the trigger function under migration control.
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned; no
-- inner BEGIN/COMMIT (pg-migrate owns the txn); CREATE OR REPLACE everywhere so
-- the file is idempotent; every internal ';' inside a function body carries a
-- trailing '-- $' marker so pg-migrate's /;\s*\n/ splitter can't carve the
-- PL/pgSQL bodies apart.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1. Receipt-time reconcile — drop-ship discriminator + non-cancelled-DO filter.
CREATE OR REPLACE FUNCTION scm.fn_reconcile_dropship_batch(
  p_warehouse_id  UUID,
  p_product_code  TEXT,
  p_variant_key   TEXT,
  p_batch_no      TEXT,
  p_created_by    UUID
) RETURNS INTEGER
SET search_path = scm, pg_temp
AS $$
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
    SELECT m.id, m.qty, m.source_doc_type, m.source_doc_id, m.source_doc_no
      FROM scm.inventory_movements m
     WHERE m.movement_type = 'OUT'
       AND m.warehouse_id  = p_warehouse_id
       AND m.product_code  = p_product_code
       AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
       AND m.batch_no      = p_batch_no
       AND m.source_doc_type = 'DO'
       AND EXISTS (
         SELECT 1 FROM scm.delivery_orders d
          WHERE d.id = m.source_doc_id
            AND d.is_dropship = TRUE
            AND UPPER(COALESCE(d.status, '')) <> 'CANCELLED'
       )
     ORDER BY m.created_at ASC, m.id ASC
     FOR UPDATE OF m
  LOOP
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id; -- $
    v_short := ABS(v_out.qty) - v_already; -- $
    CONTINUE WHEN v_short <= 0; -- $

    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen, company_id
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
        source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
        company_id
      ) VALUES (
        v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
        v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
        v_out.source_doc_type, v_out.source_doc_id, v_out.source_doc_no, v_out.id, p_created_by,
        v_lot.company_id
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
  'Receipt-time drop-ship reconcile (0057, hardened by 0088). For ONE (warehouse, product, variant, batch) bucket, consumes each GENUINE drop-ship OUT movement''s outstanding (uncosted) qty from the batch''s newly-received open lots (FIFO, at the lot''s real cost). 0088 scopes the OUT loop to source DOs with is_dropship = TRUE and status <> CANCELLED, so an uncosted NORMAL short-ship (concurrent-DO race) or a cancelled drop-ship DO can never steal the arriving lots. Idempotent + ledger-driven.';

-- 2. Cancel-path reversal for a drop-ship DO's batched buckets (C2 + H4).
CREATE OR REPLACE FUNCTION scm.fn_reverse_dropship_do_out(
  p_do_id        UUID,
  p_performed_by UUID
) RETURNS INTEGER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_bucket   RECORD; -- $
  v_con      RECORD; -- $
  v_adj_id   UUID; -- $
  v_net      INTEGER; -- $
  v_written  INTEGER := 0; -- $
  v_existing INTEGER; -- $
BEGIN
  -- Idempotency — reversal rows are tagged source_doc_type='ADJUSTMENT' +
  -- this DO's id (same signal the route-side guard checks). Already there ->
  -- the reversal (this fn or the legacy route path) already ran.
  SELECT COUNT(*) INTO v_existing
    FROM scm.inventory_movements
   WHERE source_doc_type = 'ADJUSTMENT'
     AND source_doc_id   = p_do_id; -- $
  IF v_existing > 0 THEN
    RETURN 0; -- $
  END IF; -- $

  FOR v_bucket IN
    SELECT m.warehouse_id,
           m.product_code,
           COALESCE(m.variant_key, '')                                   AS vkey,
           m.batch_no,
           SUM(CASE WHEN m.movement_type = 'OUT' THEN m.qty ELSE 0 END)  AS out_qty,
           SUM(CASE WHEN m.movement_type = 'IN'  THEN m.qty ELSE 0 END)  AS in_qty,
           MAX(m.product_name)                                           AS product_name,
           MAX(m.source_doc_no)                                          AS doc_no,
           MAX(m.company_id)                                             AS company_id
      FROM scm.inventory_movements m
     WHERE m.source_doc_type = 'DO'
       AND m.source_doc_id   = p_do_id
       AND m.movement_type IN ('IN', 'OUT')
       AND m.batch_no IS NOT NULL
     GROUP BY m.warehouse_id, m.product_code, COALESCE(m.variant_key, ''), m.batch_no
  LOOP
    -- a. Restore every lot consumption linked to this DO's OUT movements in
    --    the bucket (GRN-reconcile consumptions AND normal FIFO-trigger
    --    consumptions alike): the consumed lot gets its qty back at its
    --    ORIGINAL cost, and the consumption row (COGS attribution to a now-
    --    cancelled DO) is deleted.
    FOR v_con IN
      SELECT c.id, c.lot_id, c.qty_consumed
        FROM scm.inventory_lot_consumptions c
        JOIN scm.inventory_movements mo ON mo.id = c.movement_id
       WHERE mo.source_doc_type = 'DO'
         AND mo.source_doc_id   = p_do_id
         AND mo.movement_type   = 'OUT'
         AND mo.warehouse_id    = v_bucket.warehouse_id
         AND mo.product_code    = v_bucket.product_code
         AND COALESCE(mo.variant_key, '') = v_bucket.vkey
         AND mo.batch_no        = v_bucket.batch_no
       FOR UPDATE OF c
    LOOP
      UPDATE scm.inventory_lots
         SET qty_remaining = qty_remaining + v_con.qty_consumed
       WHERE id = v_con.lot_id; -- $
      DELETE FROM scm.inventory_lot_consumptions WHERE id = v_con.id; -- $
    END LOOP; -- $

    -- b. Zero the OUT movements' cost stamps — their consumptions are gone, so
    --    a stamped cost would be a COGS figure with no ledger backing.
    UPDATE scm.inventory_movements
       SET total_cost_sen = 0, unit_cost_sen = 0
     WHERE source_doc_type = 'DO'
       AND source_doc_id   = p_do_id
       AND movement_type   = 'OUT'
       AND warehouse_id    = v_bucket.warehouse_id
       AND product_code    = v_bucket.product_code
       AND COALESCE(variant_key, '') = v_bucket.vkey
       AND batch_no        = v_bucket.batch_no; -- $

    -- c. Close still-intact lots minted by this DO's OWN delta-IN movements
    --    (a resync qty-decrease wrote a batched IN whose lot is phantom for an
    --    un-received drop-ship). Only fully-untouched lots (qty_remaining =
    --    qty_received) are closed — a lot another document already consumed
    --    from is left alone.
    UPDATE scm.inventory_lots l
       SET qty_remaining = 0
     WHERE l.qty_remaining = l.qty_received
       AND l.qty_received > 0
       AND l.movement_id IN (
         SELECT mi.id FROM scm.inventory_movements mi
          WHERE mi.source_doc_type = 'DO'
            AND mi.source_doc_id   = p_do_id
            AND mi.movement_type   = 'IN'
            AND mi.warehouse_id    = v_bucket.warehouse_id
            AND mi.product_code    = v_bucket.product_code
            AND COALESCE(mi.variant_key, '') = v_bucket.vkey
            AND mi.batch_no        = v_bucket.batch_no
       ); -- $

    -- d. One balancing ADJUSTMENT (+net_out) so inventory_balances nets to the
    --    physical truth, then close the lot the trigger's ADJUSTMENT branch
    --    opened: the goods were either restored to their original lots in (a),
    --    or were never physically received (pure drop-ship, C2) — a fresh open
    --    lot here would be phantom coverage either way.
    v_net := COALESCE(v_bucket.out_qty, 0) - COALESCE(v_bucket.in_qty, 0); -- $
    IF v_net > 0 THEN
      INSERT INTO scm.inventory_movements (
        movement_type, warehouse_id, product_code, variant_key, product_name,
        qty, batch_no, source_doc_type, source_doc_id, source_doc_no,
        performed_by, notes, company_id
      ) VALUES (
        'ADJUSTMENT', v_bucket.warehouse_id, v_bucket.product_code, v_bucket.vkey,
        v_bucket.product_name, v_net, v_bucket.batch_no,
        'ADJUSTMENT', p_do_id, v_bucket.doc_no, p_performed_by,
        'Drop-ship DO ' || COALESCE(v_bucket.doc_no, p_do_id::text)
          || ' cancelled - reversing shipment (balance restored, no lot minted)',
        v_bucket.company_id
      ) RETURNING id INTO v_adj_id; -- $

      UPDATE scm.inventory_lots SET qty_remaining = 0 WHERE movement_id = v_adj_id; -- $
      UPDATE scm.inventory_movements SET total_cost_sen = 0, unit_cost_sen = 0 WHERE id = v_adj_id; -- $
      v_written := v_written + 1; -- $
    END IF; -- $
  END LOOP; -- $

  RETURN v_written; -- $
END; -- $
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_reverse_dropship_do_out(UUID, UUID) IS
  'Cancel-path reversal for a drop-ship DO''s BATCHED buckets (0088, audit C2+H4). Restores + deletes the DO''s lot consumptions (original lots come back at original cost, no orphan COGS), zeroes the OUT cost stamps, closes phantom lots minted by the DO''s own delta-INs, and writes ONE balancing ADJUSTMENT per bucket whose trigger-minted lot is immediately closed - so cancelling a drop-ship DO never mints phantom open coverage (cancel-before-receive) and never strands consumptions (cancel-after-receive). Idempotent via the ADJUSTMENT-sourced-row existence check. Unbatched buckets stay with the route-side plain ADJUSTMENT path.';

-- 3. FIFO movement trigger fn — company_id fix in the ADJUSTMENT qty>0 branch
--    (scm.inventory_lots.company_id is NOT NULL since 0083; without this every
--    positive ADJUSTMENT insert -- all DO-cancel add-backs -- rolls back).
--    Otherwise byte-for-byte the version from scripts/scm-schema/
--    inventory-fifo-trigger.sql (ports of 2990 migs 0095/0121/0126).
CREATE OR REPLACE FUNCTION scm.fn_inventory_movement_fifo() RETURNS TRIGGER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_result    RECORD; -- $
  v_abs_qty   INTEGER; -- $
  v_avg_cost  INTEGER; -- $
  v_unit_cost INTEGER; -- $
BEGIN
  IF NEW.movement_type = 'IN' THEN
    INSERT INTO inventory_lots (
      warehouse_id, product_code, variant_key, product_name,
      qty_received, qty_remaining, unit_cost_sen,
      received_at, source_doc_type, source_doc_id, source_doc_no,
      movement_id, created_by, batch_no, company_id
    ) VALUES (
      NEW.warehouse_id, NEW.product_code, NEW.variant_key, NEW.product_name,
      NEW.qty, NEW.qty, COALESCE(NEW.unit_cost_sen, 0),
      NEW.created_at,
      NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
      NEW.id, NEW.performed_by, NEW.batch_no, NEW.company_id
    ); -- $
    UPDATE inventory_movements
       SET total_cost_sen = NEW.qty * COALESCE(NEW.unit_cost_sen, 0)
     WHERE id = NEW.id; -- $

  ELSIF NEW.movement_type = 'OUT' THEN
    v_abs_qty := ABS(NEW.qty); -- $
    IF NEW.batch_no IS NOT NULL THEN
      SELECT * INTO v_result
        FROM fn_consume_fifo_batch(
          NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.batch_no,
          NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
          NEW.id, NEW.performed_by
        ); -- $
    ELSE
      SELECT * INTO v_result
        FROM fn_consume_fifo(
          NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty,
          NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
          NEW.id, NEW.performed_by
        ); -- $
    END IF; -- $
    UPDATE inventory_movements
       SET total_cost_sen = v_result.total_cost_sen,
           unit_cost_sen  = CASE WHEN v_abs_qty > 0
                                 THEN v_result.total_cost_sen / v_abs_qty
                                 ELSE 0 END
     WHERE id = NEW.id; -- $

  ELSIF NEW.movement_type = 'ADJUSTMENT' THEN
    IF NEW.qty > 0 THEN
      SELECT CASE WHEN SUM(qty_remaining) > 0
                  THEN SUM(qty_remaining * unit_cost_sen) / SUM(qty_remaining)
                  ELSE 0 END
        INTO v_avg_cost
        FROM inventory_lots
       WHERE warehouse_id = NEW.warehouse_id
         AND product_code = NEW.product_code
         AND variant_key  = NEW.variant_key
         AND qty_remaining > 0; -- $

      v_unit_cost := COALESCE(NULLIF(NEW.unit_cost_sen, 0), v_avg_cost, 0); -- $

      INSERT INTO inventory_lots (
        warehouse_id, product_code, variant_key, product_name,
        qty_received, qty_remaining, unit_cost_sen,
        received_at, source_doc_type, source_doc_id, source_doc_no,
        movement_id, created_by, batch_no, company_id
      ) VALUES (
        NEW.warehouse_id, NEW.product_code, NEW.variant_key, NEW.product_name,
        NEW.qty, NEW.qty, v_unit_cost,
        NEW.created_at,
        NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
        NEW.id, NEW.performed_by, NEW.batch_no, NEW.company_id
      ); -- $
      UPDATE inventory_movements
         SET total_cost_sen = NEW.qty * v_unit_cost,
             unit_cost_sen  = v_unit_cost
       WHERE id = NEW.id; -- $

    ELSIF NEW.qty < 0 THEN
      v_abs_qty := ABS(NEW.qty); -- $
      IF NEW.batch_no IS NOT NULL THEN
        SELECT * INTO v_result
          FROM fn_consume_fifo_batch(
            NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.batch_no,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          ); -- $
      ELSE
        SELECT * INTO v_result
          FROM fn_consume_fifo(
            NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          ); -- $
      END IF; -- $
      UPDATE inventory_movements
         SET total_cost_sen = v_result.total_cost_sen,
             unit_cost_sen  = CASE WHEN v_abs_qty > 0
                                   THEN v_result.total_cost_sen / v_abs_qty
                                   ELSE 0 END
       WHERE id = NEW.id; -- $
    END IF; -- $
  END IF; -- $

  RETURN NEW; -- $
END; -- $
$$ LANGUAGE plpgsql;
