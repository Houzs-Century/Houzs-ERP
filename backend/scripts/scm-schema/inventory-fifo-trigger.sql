-- ----------------------------------------------------------------------------
-- scm FIFO inventory trigger + functions — port of 2990's migrations
-- 0095 (variant-aware fn_consume_fifo), 0121 (fn_consume_fifo_batch + trigger),
-- 0126 (final fn_inventory_movement_fifo with IN/OUT/ADJUSTMENT branches).
--
-- WHY THIS EXISTS
--   The Houzs `scm` schema was built from a Drizzle table/enum/FK export
--   (2990s-full-schema.sql) plus a views-only port (apply-scm-views.mjs, which
--   regex-extracts ONLY `CREATE VIEW`). Neither carried the hand-written
--   PL/pgSQL functions or the AFTER-INSERT trigger that turn an
--   inventory_movements row into FIFO lots / consumptions. Result: a GRN post
--   inserts a movement, but NO inventory_lot is created (and OUT movements never
--   consume / cost anything). This restores that layer.
--
-- ADDITIVE + IDEMPOTENT — pure CREATE OR REPLACE FUNCTION + (re)CREATE TRIGGER.
-- Touches no table data. Safe to re-run. Tables/columns it references
-- (inventory_lots.variant_key/batch_no, inventory_lot_consumptions.variant_key)
-- already exist in scm.
--
-- MULTI-COMPANY (2026-07, migration 0061): inventory_lots.company_id and
-- inventory_lot_consumptions.company_id are now NOT NULL. The trigger creates
-- those rows, so it MUST carry company_id or every stock IN/OUT (GRN/DO/return)
-- would violate the constraint and roll the movement back. A lot inherits the
-- MOVEMENT's company (NEW.company_id — the route stamps it); a consumption
-- inherits the LOT it draws from (v_lot.company_id). Under per-company isolation
-- these are the same company. Re-run this whenever 0061 is (re)applied.
--
-- Apply into the `scm` schema (search_path = scm, public).
-- ----------------------------------------------------------------------------

-- ── Plain FIFO consumer (variant-keyed) — port of 0095 ─────────────────────
CREATE OR REPLACE FUNCTION fn_consume_fifo(
  p_warehouse_id    UUID,
  p_product_code    TEXT,
  p_variant_key     TEXT,
  p_qty_needed      INTEGER,
  p_source_doc_type TEXT,
  p_source_doc_id   UUID,
  p_source_doc_no   TEXT,
  p_movement_id     UUID,
  p_created_by      UUID
) RETURNS TABLE (total_cost_sen INTEGER, qty_short INTEGER)
-- Pin to scm so unqualified table names never resolve to a same-named
-- public.* table (Houzs's legacy inventory_lots has an INTEGER created_by —
-- without this the trigger raises a type mismatch and the movement INSERT
-- rolls back, so no stock is ever booked). pg_temp last per Supabase guidance.
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_lot        RECORD;
  v_take       INTEGER;
  v_remaining  INTEGER := p_qty_needed;
  v_total_cost INTEGER := 0;
BEGIN
  FOR v_lot IN
    SELECT id, qty_remaining, unit_cost_sen, company_id
      FROM inventory_lots
     WHERE warehouse_id = p_warehouse_id
       AND product_code = p_product_code
       AND variant_key  = p_variant_key
       AND qty_remaining > 0
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_lot.qty_remaining, v_remaining);
    v_total_cost := v_total_cost + (v_take * v_lot.unit_cost_sen);
    v_remaining := v_remaining - v_take;

    UPDATE inventory_lots
       SET qty_remaining = qty_remaining - v_take
     WHERE id = v_lot.id;

    INSERT INTO inventory_lot_consumptions (
      lot_id, warehouse_id, product_code, variant_key,
      qty_consumed, unit_cost_sen, total_cost_sen,
      source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
      company_id
    ) VALUES (
      v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
      v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
      p_source_doc_type, p_source_doc_id, p_source_doc_no, p_movement_id, p_created_by,
      v_lot.company_id
    );
  END LOOP;

  RETURN QUERY SELECT v_total_cost, GREATEST(v_remaining, 0);
END;
$$ LANGUAGE plpgsql;

-- ── Batch-scoped FIFO consumer (sofa dye-lot) — port of 0121 ───────────────
CREATE OR REPLACE FUNCTION fn_consume_fifo_batch(
  p_warehouse_id    UUID,
  p_product_code    TEXT,
  p_variant_key     TEXT,
  p_qty_needed      INTEGER,
  p_batch_no        TEXT,
  p_source_doc_type TEXT,
  p_source_doc_id   UUID,
  p_source_doc_no   TEXT,
  p_movement_id     UUID,
  p_created_by      UUID
) RETURNS TABLE (total_cost_sen INTEGER, qty_short INTEGER)
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_lot        RECORD;
  v_take       INTEGER;
  v_remaining  INTEGER := p_qty_needed;
  v_total_cost INTEGER := 0;
BEGIN
  FOR v_lot IN
    SELECT id, qty_remaining, unit_cost_sen, company_id
      FROM inventory_lots
     WHERE warehouse_id = p_warehouse_id
       AND product_code = p_product_code
       AND variant_key  = p_variant_key
       AND batch_no     = p_batch_no
       AND qty_remaining > 0
     ORDER BY received_at ASC, id ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_lot.qty_remaining, v_remaining);
    v_total_cost := v_total_cost + (v_take * v_lot.unit_cost_sen);
    v_remaining := v_remaining - v_take;

    UPDATE inventory_lots
       SET qty_remaining = qty_remaining - v_take
     WHERE id = v_lot.id;

    INSERT INTO inventory_lot_consumptions (
      lot_id, warehouse_id, product_code, variant_key,
      qty_consumed, unit_cost_sen, total_cost_sen,
      source_doc_type, source_doc_id, source_doc_no, movement_id, created_by,
      company_id
    ) VALUES (
      v_lot.id, p_warehouse_id, p_product_code, p_variant_key,
      v_take, v_lot.unit_cost_sen, v_take * v_lot.unit_cost_sen,
      p_source_doc_type, p_source_doc_id, p_source_doc_no, p_movement_id, p_created_by,
      v_lot.company_id
    );
  END LOOP;

  RETURN QUERY SELECT v_total_cost, GREATEST(v_remaining, 0);
END;
$$ LANGUAGE plpgsql;

-- ── Movement trigger fn — final IN/OUT/ADJUSTMENT version, port of 0126 ─────
-- Ledger-divergence fix (migration 0195, 2026-07-25): the OUT + negative-
-- ADJUSTMENT branches now FALL BACK from the exact-batch consume to plain
-- product+variant fn_consume_fifo for whatever the batch consume shorted, so a
-- sofa OUT whose batch_no drifts from its open lots' batch (the MAKOTO false
-- short) can no longer ship uncosted + un-decremented. Kept in lockstep with
-- backend/src/db/migrations-pg/0195_scm_fifo_out_short_batch_fallback.sql — the
-- two MUST define this function identically. A genuine short (no stock at all)
-- still returns qty_short and stays on the 0154 retro-cost path, unchanged.
CREATE OR REPLACE FUNCTION fn_inventory_movement_fifo() RETURNS TRIGGER
SET search_path = scm, pg_temp
AS $$
DECLARE
  v_result    RECORD;
  v_fallback  RECORD;
  v_abs_qty   INTEGER;
  v_cost      INTEGER;
  v_short     INTEGER;
  v_avg_cost  INTEGER;
  v_unit_cost INTEGER;
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
    );
    UPDATE inventory_movements
       SET total_cost_sen = NEW.qty * COALESCE(NEW.unit_cost_sen, 0)
     WHERE id = NEW.id;

  ELSIF NEW.movement_type = 'OUT' THEN
    v_abs_qty := ABS(NEW.qty);
    IF NEW.batch_no IS NOT NULL THEN
      -- Exact dye-lot batch consume first (sofa set stays colour-matched).
      SELECT * INTO v_result
        FROM fn_consume_fifo_batch(
          NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.batch_no,
          NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
          NEW.id, NEW.performed_by
        );
      v_cost  := v_result.total_cost_sen;
      v_short := v_result.qty_short;
      -- Ledger-divergence fix (0195): the exact batch matched no (or too few)
      -- open lots. Rather than DISCARD the short (leaving the OUT uncosted + the
      -- lots un-decremented forever — the MAKOTO false-short), fall back to plain
      -- product+variant FIFO (any batch) for the residual so present stock of the
      -- same SKU is consumed + costed.
      IF v_short > 0 THEN
        SELECT * INTO v_fallback
          FROM fn_consume_fifo(
            NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_short,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          );
        v_cost  := v_cost + v_fallback.total_cost_sen;
        v_short := v_fallback.qty_short;
      END IF;
    ELSE
      SELECT * INTO v_result
        FROM fn_consume_fifo(
          NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty,
          NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
          NEW.id, NEW.performed_by
        );
      v_cost  := v_result.total_cost_sen;
      v_short := v_result.qty_short;
    END IF;
    UPDATE inventory_movements
       SET total_cost_sen = v_cost,
           unit_cost_sen  = CASE WHEN v_abs_qty > 0
                                 THEN v_cost / v_abs_qty
                                 ELSE 0 END
     WHERE id = NEW.id;

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
         AND qty_remaining > 0;

      v_unit_cost := COALESCE(NULLIF(NEW.unit_cost_sen, 0), v_avg_cost, 0);

      -- company_id fix (migration 0088): inventory_lots.company_id is NOT NULL
      -- since 0083 — without it every positive ADJUSTMENT (DO-cancel add-backs)
      -- would violate the constraint and roll the movement back.
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
      );
      UPDATE inventory_movements
         SET total_cost_sen = NEW.qty * v_unit_cost,
             unit_cost_sen  = v_unit_cost
       WHERE id = NEW.id;

    ELSIF NEW.qty < 0 THEN
      v_abs_qty := ABS(NEW.qty);
      IF NEW.batch_no IS NOT NULL THEN
        SELECT * INTO v_result
          FROM fn_consume_fifo_batch(
            NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty, NEW.batch_no,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          );
        v_cost  := v_result.total_cost_sen;
        v_short := v_result.qty_short;
        -- Same batch-drift fallback as the OUT branch (0195): a batched write-off
        -- that matches no exact-batch lot consumes present same-SKU stock plain-
        -- FIFO instead of silently stranding the units.
        IF v_short > 0 THEN
          SELECT * INTO v_fallback
            FROM fn_consume_fifo(
              NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_short,
              NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
              NEW.id, NEW.performed_by
            );
          v_cost  := v_cost + v_fallback.total_cost_sen;
          v_short := v_fallback.qty_short;
        END IF;
      ELSE
        SELECT * INTO v_result
          FROM fn_consume_fifo(
            NEW.warehouse_id, NEW.product_code, NEW.variant_key, v_abs_qty,
            NEW.source_doc_type, NEW.source_doc_id, NEW.source_doc_no,
            NEW.id, NEW.performed_by
          );
        v_cost  := v_result.total_cost_sen;
        v_short := v_result.qty_short;
      END IF;
      UPDATE inventory_movements
         SET total_cost_sen = v_cost,
             unit_cost_sen  = CASE WHEN v_abs_qty > 0
                                   THEN v_cost / v_abs_qty
                                   ELSE 0 END
       WHERE id = NEW.id;
    END IF;
    -- NEW.qty = 0 ADJUSTMENT is a no-op.
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Trigger ────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_inventory_movement_fifo ON inventory_movements;
CREATE TRIGGER trg_inventory_movement_fifo
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION fn_inventory_movement_fifo();
