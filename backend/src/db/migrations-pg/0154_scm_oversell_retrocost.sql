-- ----------------------------------------------------------------------------
-- 0154 — Oversell (short-shipped) retro-costing for NON-drop-ship DO OUTs.
--
-- THE BUG (money-critical, owner-approved fix 2026-07-20).
--   The soft "ship anyway" oversell path (check-stock-availability.ts +
--   confirmShortStock) lets a DO ship MORE than the warehouse holds. The FIFO
--   trigger's fn_consume_fifo then costs only what is on hand and RETURNS the
--   uncosted remainder as qty_short — which the trigger DISCARDS. So the OUT
--   movement's total_cost_sen reflects only the available units, the short units
--   ship at ZERO recorded cost, and inventory_balances goes negative. For
--   drop-ship (batched) DOs the receipt-time reconcile (fn_reconcile_dropship_batch,
--   0057/0088) later catches those short units up when stock arrives — but it is
--   scoped to is_dropship = TRUE + a matching batch, so a NORMAL oversold DO is
--   NEVER retro-costed. COGS stays understated -> margin/profit OVERSTATED
--   permanently, and the two on-hand views diverge forever: inventory_balances
--   (signed movement sum) shows the true negative/low qty, while v_inventory_value
--   (Σ inventory_lots.qty_remaining) still shows the un-consumed lot qty.
--
-- THE FIX.
--   fn_reconcile_uncosted_out — a GENERALISATION of fn_reconcile_dropship_batch
--   to non-drop-ship DO OUTs. Called from the GRN post handler (the IN that adds
--   stock) via the app wrapper reconcileUncostedOuts, once per received
--   (warehouse, product, variant) bucket. For each PRIOR uncosted short OUT in
--   that bucket it consumes the outstanding shortfall from the newly-received
--   open lots (plain FIFO, at the lot's REAL cost), booking inventory_lot_
--   consumptions + decrementing inventory_lots + restamping the OUT's COGS. The
--   caller then re-stamps the affected DO lines + their Sales Invoices, exactly
--   like the drop-ship path. After the reconcile the lot view (Σ qty_remaining)
--   drops by the retro-consumed qty and re-converges with the balance view.
--
--   Unlike the drop-ship reconcile this MATCHES ON (warehouse, product, variant)
--   and consumes lots regardless of batch: a normal oversell ships UNBATCHED
--   (resolveWarehouseLotBatches finds no open lot to derive a dye-lot from), while
--   the arriving GRN lot is batched with its source PO number (0120) — so a
--   batch-scoped reconcile would never match them. Plain-FIFO consumption mirrors
--   what fn_consume_fifo would have done at ship time had the stock been present.
--
-- ANTI-RACE ("coverage-theft") GUARD — the reason 0088 scoped so narrowly.
--   A later legitimate order's stock must NOT be diverted to cover an old short.
--   Three guards make every reconcile a TRUE prior shortfall only:
--     1. TEMPORAL — only OUTs with created_at < p_before_ts (the receipt moment,
--        captured by the caller right after the IN rows post). An order that ships
--        AT or AFTER the receipt is not a prior shortfall; it consumes the lot
--        through the normal FIFO trigger at its own ship time and is never touched
--        here. This is the direct defence against stealing a fresh order's stock.
--     2. OLDEST-FIRST — ORDER BY created_at ASC, so when arriving stock cannot
--        cover every prior short, the earliest shipment has first claim (FIFO).
--     3. IDEMPOTENT — the shortfall is recomputed from the ledger every run
--        (ABS(OUT.qty) - Σ already-consumed for that movement). A short reconciled
--        once has consumption rows, so its shortfall is 0 on re-run and is never
--        double-costed. Row locks (FOR UPDATE) serialise concurrent receipts.
--   Drop-ship OUTs are excluded (is_dropship = FALSE) so the hardened 0088 path
--   remains the sole owner of batched drop-ship coverage; CANCELLED DOs are
--   excluded (their OUTs were already reversed). Lot consumption is pinned to the
--   OUT's own company_id so a short is never costed from another company's stock.
--
-- WHY A DB FUNCTION (not a pure app-layer fix).
--   The reconcile must, atomically and under row-level locks, walk FIFO lots,
--   insert consumptions, decrement lots and restamp the OUT cost. That SELECT ...
--   FOR UPDATE serialisation cannot be expressed through PostgREST/supabase-js;
--   emulating it in the app layer would open a money-critical race (two receipts
--   double-consuming a lot, or a reconcile racing a concurrent ship). This is the
--   same reason fn_reconcile_dropship_batch lives in the DB. This migration is
--   PURELY ADDITIVE — CREATE OR REPLACE of one NEW function. It does NOT touch the
--   FIFO trigger, fn_consume_fifo, the inventory_lots DDL, or the uq_inv_mov_*
--   unique indexes (the objects applied DIRECTLY to prod in PR #674, outside this
--   migration tree).
--
-- !! STAGING-FIRST — DO NOT ASSUME AUTO-APPLY IS SAFE HERE. !!
--   CI pg-migrates PROD on every deploy, so merging this WILL run it against prod.
--   Because it operates on the money-critical scm FIFO layer that lives directly
--   in prod (inventory_lots / inventory_lot_consumptions / inventory_movements)
--   and is NOT fully reproducible from this repo, it MUST be validated on STAGING
--   first via the Supabase management API (ref minnapsemfzjmtvnnvdd) BEFORE this
--   PR is merged. Coordinate the apply — do not merge blind.
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned to scm,
-- pg_temp; no inner BEGIN/COMMIT (pg-migrate owns the txn); dollar-quoted body
-- ($fn$) so scripts/lib/split-sql.mjs keeps the PL/pgSQL intact; CREATE OR REPLACE
-- so the file is idempotent + re-runnable.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

CREATE OR REPLACE FUNCTION scm.fn_reconcile_uncosted_out(
  p_warehouse_id  UUID,
  p_product_code  TEXT,
  p_variant_key   TEXT,
  p_before_ts     TIMESTAMPTZ,
  p_created_by    UUID
) RETURNS INTEGER
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_out       RECORD;
  v_lot       RECORD;
  v_already   INTEGER;
  v_short     INTEGER;
  v_take      INTEGER;
  v_consumed  INTEGER := 0;
BEGIN
  -- Prior, non-cancelled, NON-drop-ship DO OUTs in this SKU bucket that shipped
  -- BEFORE the stock arrived and still carry uncosted short qty. Oldest first.
  FOR v_out IN
    SELECT m.id, m.qty, m.company_id,
           m.source_doc_type, m.source_doc_id, m.source_doc_no
      FROM scm.inventory_movements m
     WHERE m.movement_type   = 'OUT'
       AND m.warehouse_id     = p_warehouse_id
       AND m.product_code     = p_product_code
       AND COALESCE(m.variant_key, '') = COALESCE(p_variant_key, '')
       AND m.source_doc_type  = 'DO'
       AND m.created_at       < p_before_ts
       AND EXISTS (
         SELECT 1 FROM scm.delivery_orders d
          WHERE d.id = m.source_doc_id
            AND COALESCE(d.is_dropship, FALSE) = FALSE
            AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
       )
     ORDER BY m.created_at ASC, m.id ASC
     FOR UPDATE OF m
  LOOP
    -- Idempotency: the outstanding shortfall shrinks by whatever a prior run
    -- (or the ship-time trigger) already costed. 0 -> nothing left to retro-cost.
    SELECT COALESCE(SUM(qty_consumed), 0) INTO v_already
      FROM scm.inventory_lot_consumptions
     WHERE movement_id = v_out.id;
    v_short := ABS(v_out.qty) - v_already;
    CONTINUE WHEN v_short <= 0;

    -- Consume the shortfall from this SKU's newly-available open lots (plain
    -- FIFO, any batch), pinned to the OUT's own company. Never below zero.
    FOR v_lot IN
      SELECT id, qty_remaining, unit_cost_sen, company_id
        FROM scm.inventory_lots
       WHERE warehouse_id = p_warehouse_id
         AND product_code = p_product_code
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
        lot_id, warehouse_id, product_code, variant_key,
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
    END LOOP;

    -- Restamp the OUT's COGS from its (now topped-up) consumptions. A pure SUM of
    -- what actually consumed — never a fabricated fallback cost. If no lot was
    -- available (v_short still > 0) the movement keeps its partial cost and the
    -- residual shortfall is retro-costed by the NEXT receipt (still idempotent).
    UPDATE scm.inventory_movements m
       SET total_cost_sen = sub.total_cost,
           unit_cost_sen  = CASE WHEN ABS(m.qty) > 0
                                 THEN sub.total_cost / ABS(m.qty) ELSE 0 END
      FROM (
        SELECT COALESCE(SUM(total_cost_sen), 0) AS total_cost
          FROM scm.inventory_lot_consumptions
         WHERE movement_id = v_out.id
      ) sub
     WHERE m.id = v_out.id;
  END LOOP;

  RETURN v_consumed;
END;
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_reconcile_uncosted_out(UUID, TEXT, TEXT, TIMESTAMPTZ, UUID) IS
  'Receipt-time retro-cost for oversold (short-shipped) NON-drop-ship DO OUTs (0154). Generalises fn_reconcile_dropship_batch to the normal-DO oversell case: for ONE (warehouse, product, variant) bucket it consumes each PRIOR uncosted short OUT''s outstanding qty from the newly-received open lots (plain FIFO, any batch, at the lot''s real cost), booking consumptions + decrementing lots + restamping the OUT COGS, so margins catch up and the balance/lot views re-converge. Anti coverage-theft: only OUTs with created_at < p_before_ts (prior to the receipt), oldest first, is_dropship = FALSE, status <> CANCELLED, company-pinned; idempotent via ledger-recomputed shortfall (a short costed once is never double-costed). Drop-ship batched coverage stays owned by 0088.';
