-- ----------------------------------------------------------------------------
-- RE-CHECK NUMBER AT MERGE — parallel PRs; last on main was 0197 when branched.
-- (This is a money-path / FIFO-costing change: DRAFT, staging-first, owner-gated.)
--
-- 0198 — R4: cancelling a NON-drop-ship DO now restores its inventory lot
-- consumptions the SAME way the drop-ship cancel path already does.
--
-- Audit: docs/inventory-costing-integrity-audit.md R4. Owner decision (2026-07-25):
-- "a cancelled non-drop-ship DO MUST restore its lot consumptions" — the ship
-- consumed real lots, so cancelling must give those exact lots back.
--
-- THE DEFECT (before this file):
--   reverseInventoryForDo (delivery-orders-mfg.ts) reversed a cancelled
--   NON-drop-ship DO by writing a POSITIVE ADJUSTMENT (qty = +net_out,
--   unit_cost_sen = round(out_total_cost / out_qty)) per plain bucket, or a
--   batch-restoring IN for sofa buckets. That:
--     a. did NOT delete the DO's inventory_lot_consumptions rows — so
--        v_cogs_entries / inventory_lot_consumptions kept a CANCELLED sale's
--        COGS attributed to the cancelled document; and
--     b. re-added the stock as a NEW lot at the AVERAGE consumed cost at the
--        BACK of the FIFO queue, not the ORIGINAL lots at their ORIGINAL cost in
--        their ORIGINAL FIFO position — disturbing later COGS layering.
--   Only the DROP-SHIP path did it correctly, via fn_reverse_dropship_do_out
--   (0088): restore + DELETE the DO's consumptions (originals return at original
--   cost), zero the OUT cost stamps, write a balance-only add-back.
--
-- THE FIX (this file): GENERALIZE the audited drop-ship reversal so BOTH paths
-- share ONE implementation.
--   1. fn_reverse_do_out(p_do_id, p_performed_by, p_batched_only) — NEW. The
--      byte-for-byte body of fn_reverse_dropship_do_out (0088), with two changes:
--        - the bucket selector's `batch_no IS NOT NULL` becomes
--          `(NOT p_batched_only OR batch_no IS NOT NULL)`, so with
--          p_batched_only = FALSE it also processes PLAIN (unbatched) buckets;
--        - every `batch_no = v_bucket.batch_no` comparison becomes NULL-safe
--          (`IS NOT DISTINCT FROM`) so a plain bucket (batch_no = NULL) matches
--          its own movements/lots. For a non-NULL batch this is identical to `=`,
--          so the drop-ship (batched) behaviour is bit-for-bit unchanged.
--      Steps (a) restore+delete consumptions, (b) zero OUT cost stamps,
--      (c) close phantom delta-IN lots, (d) balance-only +net_out ADJUSTMENT with
--      its trigger-minted lot immediately closed — all as in 0088. So a plain
--      bucket's original lots come back at original cost in their original FIFO
--      position, the cancelled DO's consumptions leave the ledger, and qty still
--      nets to 0 across BOTH the movement ledger (the +net_out ADJUSTMENT) and
--      the lot ledger (the restored original lots; the ADJUSTMENT's own lot
--      zeroed). Sofa buckets keep their batch identity — step (a) restores the
--      EXACT original batched lot by lot_id (consistent with fn_consume_fifo_batch).
--   2. fn_reverse_dropship_do_out(p_do_id, p_performed_by) — REPLACED to simply
--      delegate: RETURN fn_reverse_do_out(p_do_id, p_performed_by, TRUE). The
--      drop-ship path is preserved EXACTLY (batched buckets only; unbatched
--      buckets still fall through to the route-side plain ADJUSTMENT path).
--
-- Route change (delivery-orders-mfg.ts, same PR): the non-drop-ship branch now
-- calls fn_reverse_do_out(..., FALSE) and, on success, writes NO route-side
-- add-back rows. If the fn is missing (pre-0198) or errors, it FALLS BACK to the
-- legacy average-cost ADJUSTMENT / batch-restoring IN so a cancel is never lost.
--
-- IDEMPOTENT: the entry guard counts existing ADJUSTMENT-sourced rows for the DO
-- (same signal the route-side guard checks) — a re-cancel is a no-op, no double
-- restore. Re-running finds the consumptions already deleted -> no-op.
--
-- NOT proven by this repo's test suite: the function firing against a REAL
-- Postgres is NOT exercised (the suite binds no PG). The last validation step is
-- a STAGING apply, run by the owner. See the PR body + BUG-HISTORY.md.
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned; no
-- inner BEGIN/COMMIT (pg-migrate owns the txn); CREATE OR REPLACE everywhere so
-- the file is idempotent; every internal ';' inside a function body carries a
-- trailing '-- $' marker so pg-migrate's /;\s*\n/ splitter can't carve the
-- PL/pgSQL bodies apart.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1. Generalized cancel-path reversal for a DO's buckets (drop-ship AND normal).
CREATE OR REPLACE FUNCTION scm.fn_reverse_do_out(
  p_do_id        UUID,
  p_performed_by UUID,
  p_batched_only BOOLEAN
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
       AND (NOT p_batched_only OR m.batch_no IS NOT NULL)
     GROUP BY m.warehouse_id, m.product_code, COALESCE(m.variant_key, ''), m.batch_no
  LOOP
    -- a. Restore every lot consumption linked to this DO's OUT movements in
    --    the bucket (GRN-reconcile consumptions AND normal FIFO-trigger
    --    consumptions alike): the consumed lot gets its qty back at its
    --    ORIGINAL cost, and the consumption row (COGS attribution to a now-
    --    cancelled DO) is deleted. batch_no match is NULL-safe so a plain
    --    (unbatched) bucket restores its own OUT's consumptions too.
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
         AND mo.batch_no IS NOT DISTINCT FROM v_bucket.batch_no
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
       AND batch_no IS NOT DISTINCT FROM v_bucket.batch_no; -- $

    -- c. Close still-intact lots minted by this DO's OWN delta-IN movements
    --    (a resync qty-decrease wrote an IN whose lot double-counts stock now
    --    that (a) has restored the original lots). Only fully-untouched lots
    --    (qty_remaining = qty_received) are closed — a lot another document
    --    already consumed from is left alone.
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
            AND mi.batch_no IS NOT DISTINCT FROM v_bucket.batch_no
       ); -- $

    -- d. One balancing ADJUSTMENT (+net_out) so inventory_balances nets to the
    --    physical truth, then close the lot the trigger's ADJUSTMENT branch
    --    opened: the goods were either restored to their original lots in (a),
    --    or were never physically received (pure drop-ship, C2) — a fresh open
    --    lot here would double-count / be phantom coverage either way.
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
        CASE WHEN p_batched_only
             THEN 'Drop-ship DO ' || COALESCE(v_bucket.doc_no, p_do_id::text)
                  || ' cancelled - reversing shipment (balance restored, no lot minted)'
             ELSE 'DO ' || COALESCE(v_bucket.doc_no, p_do_id::text)
                  || ' cancelled - original lots restored at original cost, balance-only add-back (no lot minted)'
        END,
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

COMMENT ON FUNCTION scm.fn_reverse_do_out(UUID, UUID, BOOLEAN) IS
  'Generalized cancel-path reversal for a DO''s buckets (0198, audit R4; generalizes fn_reverse_dropship_do_out 0088). Per bucket: restores + DELETES the DO''s lot consumptions (original lots come back at ORIGINAL cost in their ORIGINAL FIFO position, no orphan COGS), zeroes the OUT cost stamps, closes phantom lots minted by the DO''s own delta-INs, and writes ONE balancing +net_out ADJUSTMENT whose trigger-minted lot is immediately closed - so qty still nets to 0 (movement ledger via the ADJUSTMENT, lot ledger via the restored originals). p_batched_only = TRUE processes only batched (sofa/drop-ship) buckets, exactly as the drop-ship path did; FALSE processes ALL buckets (the non-drop-ship R4 fix). batch_no matching is NULL-safe (IS NOT DISTINCT FROM) so plain buckets match their own rows. Idempotent via the ADJUSTMENT-sourced-row existence check.';

-- 2. Drop-ship reversal now delegates to the generalized fn (batched-only) so
--    both paths share ONE audited implementation. Behaviour is bit-for-bit
--    identical to 0088 (batched buckets; unbatched buckets stay with the
--    route-side plain ADJUSTMENT path).
CREATE OR REPLACE FUNCTION scm.fn_reverse_dropship_do_out(
  p_do_id        UUID,
  p_performed_by UUID
) RETURNS INTEGER
SET search_path = scm, pg_temp
AS $$
BEGIN
  RETURN scm.fn_reverse_do_out(p_do_id, p_performed_by, TRUE); -- $
END; -- $
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_reverse_dropship_do_out(UUID, UUID) IS
  'Cancel-path reversal for a drop-ship DO''s BATCHED buckets (0088, audit C2+H4). Since 0198 delegates to scm.fn_reverse_do_out(p_do_id, p_performed_by, TRUE) so drop-ship and non-drop-ship cancels share one audited implementation; behaviour is unchanged (batched buckets only; unbatched buckets stay with the route-side plain ADJUSTMENT path).';
