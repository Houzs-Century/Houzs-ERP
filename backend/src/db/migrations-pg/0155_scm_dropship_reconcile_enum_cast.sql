-- ----------------------------------------------------------------------------
-- 0155 — HOTFIX: fn_reconcile_dropship_batch enum-coercion crash (22P02).
--
-- PRE-EXISTING PRODUCTION DEFECT, caught during STAGING validation of #874.
--   scm.fn_reconcile_dropship_batch (shipped 0057, hardened 0088) guards its OUT
--   loop with `AND UPPER(COALESCE(d.status, '')) <> 'CANCELLED'`. d.status is the
--   scm.do_status ENUM, and COALESCE(enum, '') coerces the '' literal INTO
--   scm.do_status at PLAN time — '' is not a valid enum label, so every call
--   raises `22P02 invalid input value for enum scm.do_status: ""` before a single
--   row is read. The drop-ship receipt-time retro-cost path (reconcileDropshipBatch,
--   called from the GRN post handler) is wrapped best-effort, so the throw is
--   SWALLOWED: the reconcile silently no-ops in prod RIGHT NOW. Drop-ship
--   short-shipped units are never caught up when stock arrives -> drop-ship COGS
--   understated -> margin/profit overstated — the identical money-critical failure
--   #874 exists to fix for the NORMAL-DO case. The same bug in the NEW 0154
--   function (fn_reconcile_uncosted_out) is fixed in that file; THIS migration
--   fixes the already-deployed SIBLING.
--
-- THE FIX (SQL-ONLY, ZERO BEHAVIOUR CHANGE).
--   Cast the enum to text BEFORE COALESCE: `UPPER(COALESCE(d.status::text, ''))`.
--   d.status is NOT NULL, so this is exactly the intended predicate; the ''
--   fallback is now a plain text literal and never reaches the enum input parser.
--   CREATE OR REPLACE of scm.fn_reconcile_dropship_batch with 0088's body
--   BYTE-FOR-BYTE except that one cast — identical signature, identical logic,
--   no data change. The lockstep TS model is unaffected (SQL-only fix).
--
-- !! STAGING-FIRST — same rule as 0154. CI pg-migrates PROD on deploy, and this
--   touches the money-critical scm FIFO layer. Validate on STAGING (ref
--   minnapsemfzjmtvnnvdd) BEFORE merge. Prod ref anogrigyjbduyzclzjgn must NOT be
--   touched directly.
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned; no inner
-- BEGIN/COMMIT (pg-migrate owns the txn); CREATE OR REPLACE so the file is
-- idempotent + re-runnable; every internal ';' keeps 0088's trailing '-- $' marker
-- (harmless under the current dollar-quote-aware split-sql.mjs, and safe under the
-- legacy /;\s*\n/ splitter too).
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- Receipt-time reconcile — drop-ship discriminator + non-cancelled-DO filter.
-- Body identical to 0088; the ONLY change is `d.status` -> `d.status::text` in the
-- EXISTS guard, so COALESCE's '' fallback no longer coerces into scm.do_status.
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
            AND UPPER(COALESCE(d.status::text, '')) <> 'CANCELLED'
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
  'Receipt-time drop-ship reconcile (0057, hardened by 0088, enum-cast hotfix 0155). For ONE (warehouse, product, variant, batch) bucket, consumes each GENUINE drop-ship OUT movement''s outstanding (uncosted) qty from the batch''s newly-received open lots (FIFO, at the lot''s real cost). 0088 scopes the OUT loop to source DOs with is_dropship = TRUE and status <> CANCELLED, so an uncosted NORMAL short-ship (concurrent-DO race) or a cancelled drop-ship DO can never steal the arriving lots. Idempotent + ledger-driven. 0155 casts d.status::text inside the COALESCE guard so it no longer raises 22P02 (invalid enum input "") at plan time.';
