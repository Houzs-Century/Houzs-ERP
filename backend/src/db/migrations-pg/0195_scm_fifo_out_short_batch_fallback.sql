-- ----------------------------------------------------------------------------
-- 0195 — FIFO OUT short: fall back from exact-batch to plain product+variant FIFO
--        (go-forward fix for the movement-vs-lot ledger divergence).
--
-- THE BUG (money-critical; owner report 2026-07-25, SKU MAKOTO RC(S)-FVI BRONZE,
-- KL — see docs/inventory-ledger-divergence-coe.md).
--   The FIFO trigger's OUT branch ALWAYS runs fn_consume_fifo / fn_consume_fifo_batch
--   and persists ONLY total_cost_sen onto the movement — it DISCARDS the qty_short
--   the consumer returns. A SOFA OUT routes through fn_consume_fifo_batch, which
--   requires an EXACT batch_no match (inventory-fifo-trigger.sql). When a shipped
--   DO is edited, resyncInventoryForDo writes a fresh DELTA OUT; if that OUT's
--   batch_no (the allocator's allocated_batch_no) does not string-equal the open
--   lots' batch_no (the GRN-stamped source-PO batch, migration 0120), the batch
--   consume matches ZERO lots. The loop body never runs: it returns
--   total_cost_sen = 0, qty_short = qty, inserts NO inventory_lot_consumptions row
--   and decrements NO inventory_lots row — yet the OUT movement is a real row, so
--   the signed movement balance decrements while the FIFO lots + COGS do not. The
--   two ledgers diverge permanently (MAKOTO: movements say 3 on hand, lots say 4,
--   COGS booked 1 of 2 OUTs) even though 4 units of the SAME product+variant were
--   PHYSICALLY on hand — a FALSE short caused by the over-strict batch key.
--
-- THE FIX (narrow, additive — closes the specific hole, does NOT rewrite the engine).
--   In the OUT branch (and the symmetric negative-ADJUSTMENT write-off branch),
--   when the exact-batch consume returns qty_short > 0, FALL BACK to plain
--   product+variant fn_consume_fifo for the residual — any batch, oldest lot first.
--   The residual short units are then consumed from whatever open stock of the same
--   (warehouse, product, variant) exists, costed at the real lot cost, and the lots
--   are decremented — so a batch-key drift can no longer strand an OUT uncosted +
--   un-decremented. The movement's total_cost_sen becomes (batch cost + fallback
--   cost) and its unit_cost_sen the weighted average over the full shipped qty.
--
-- WHAT DOES NOT CHANGE.
--   - A correctly-matched OUT (batch consume fully satisfies qty) never reaches the
--     fallback (qty_short = 0) — behaviour byte-identical to before.
--   - A plain (un-batched) OUT is unchanged — it already ran fn_consume_fifo.
--   - A GENUINE short (no open stock under ANY batch for the SKU) still returns
--     qty_short > 0 after the fallback; that residual stays on the EXISTING
--     receipt-time retro-cost path (fn_reconcile_uncosted_out, migration 0154) —
--     unchanged. This migration does NOT expand that reconcile's wiring (that is
--     the separately-owned deferred fix in docs/inventory-costing-oversell-coe.md)
--     and does NOT repair historical rows (that is the owner-run backfill:
--     backend/scripts/backfill-fifo-divergence.mjs — a separate, staged step).
--
-- IDEMPOTENT + ADDITIVE — pure CREATE OR REPLACE of the ONE trigger function; it
-- calls the already-present fn_consume_fifo / fn_consume_fifo_batch unchanged, and
-- touches no table data. Mirrors backend/scripts/scm-schema/inventory-fifo-trigger.sql
-- (kept in lockstep — the canonical port and this migration MUST define the
-- function identically so a re-apply of either cannot revert the other).
--
-- !! STAGING-FIRST — DO NOT ASSUME AUTO-APPLY IS SAFE HERE. !!
--   deploy.yml pg-migrates PROD on every merge, so merging this WILL run it against
--   prod. It changes money-critical FIFO costing behaviour on the scm layer that
--   lives directly in prod and is NOT fully reproducible from this repo, so it MUST
--   be validated on STAGING first and the apply coordinated — do NOT merge blind.
--   Re-pick the migration NUMBER at merge time (parallel PRs collide on numbers).
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned to
-- scm, pg_temp; no inner BEGIN/COMMIT (pg-migrate owns the txn); dollar-quoted
-- body ($fn$) so scripts/lib/split-sql.mjs keeps the PL/pgSQL intact.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

CREATE OR REPLACE FUNCTION scm.fn_inventory_movement_fifo() RETURNS TRIGGER
SET search_path = scm, pg_temp
AS $fn$
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
      -- Ledger-divergence fix (0195): the exact batch matched no (or too few) open
      -- lots. Rather than DISCARD the short (leaving the OUT uncosted + the lots
      -- un-decremented forever — the MAKOTO false-short), fall back to plain
      -- product+variant FIFO (any batch) for the residual so present stock of the
      -- same SKU is consumed + costed. Genuine shorts (no stock at all) survive
      -- the fallback and stay on the 0154 retro-cost path, unchanged.
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
        -- Same batch-drift fallback as the OUT branch: a batched write-off that
        -- matches no exact-batch lot consumes present same-SKU stock plain-FIFO
        -- instead of silently stranding the units.
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
$fn$ LANGUAGE plpgsql;
