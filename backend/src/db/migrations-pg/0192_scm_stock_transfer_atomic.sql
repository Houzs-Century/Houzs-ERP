-- ----------------------------------------------------------------------------
-- 0192 — ATOMIC inter-warehouse stock transfer (audit finding R3).
--
-- THE BUG (money-critical).
--   A stock transfer moved stock in TWO separate, independently-committed
--   PostgREST calls: (1) INSERT the OUT@source (the AFTER-INSERT FIFO trigger
--   consumes the source lots and stamps the OUT's total_cost_sen), then (2)
--   re-read that cost and INSERT the IN@dest. supabase-js cannot open a
--   multi-statement transaction, so each INSERT auto-commits on its own. If the
--   Worker crashed, timed out, or the IN insert failed AFTER the OUT committed,
--   the source stock was consumed but never re-created at the destination —
--   stock (and its FIFO cost) DESTROYED. A best-effort JS "compensating IN@source"
--   softened this but could itself fail (leaving stock destroyed) and never ran
--   at all on a Worker crash; and on a multi-line transfer a mid-list failure
--   left earlier lines physically moved while the header was auto-cancelled —
--   inventory diverging from the ledger either way.
--
-- THE FIX.
--   scm.fn_stock_transfer_apply performs every line's OUT@source + IN@dest inside
--   ONE function invocation = ONE transaction. A PL/pgSQL function called over
--   RPC runs atomically: if ANY line's OUT or IN raises (constraint, trigger
--   error, ...), PostgreSQL rolls back the WHOLE call — every OUT and every IN
--   for every line. Stock can never be half-moved: the transfer commits in full
--   or leaves both warehouses exactly as they were. This replaces the JS
--   OUT/re-read/IN/compensate saga in scm/routes/stock-transfers.ts entirely.
--
-- COST CARRY-OVER (unchanged, now inside the txn).
--   The OUT carries no unit_cost; the AFTER-INSERT trigger's fn_consume_fifo
--   consumes the source lots FIFO and stamps the OUT's total_cost_sen. Because
--   we are in the SAME transaction, that trigger UPDATE is immediately visible:
--   we read it back and open the IN@dest at unit_cost = round(OUT.total_cost /
--   qty) — the exact weighted-average cost of the consumed source lots. A
--   transfer neither invents nor loses cost.
--
-- CONCURRENCY.
--   fn_consume_fifo (invoked by the OUT's trigger) walks inventory_lots with
--   SELECT ... FOR UPDATE. Those row locks are now held for the DURATION of the
--   whole transfer transaction (not released at a per-statement auto-commit), so
--   two transfers draining the same source bucket serialise: the second blocks
--   until the first commits and then sees the decremented qty_remaining. The same
--   source lot can never be double-consumed.
--
-- BATCH / dye-lot carry-over is resolved in the app layer (unchanged) and passed
-- in per line as p_lines[].batch_no; a non-null batch is stamped on BOTH the OUT
-- (so fn_consume_fifo_batch consumes THAT batch) and the IN (so the dest lot
-- re-opens tagged with the same batch). Empty / absent -> plain FIFO.
--
-- ADDITIVE + IDEMPOTENT — one CREATE OR REPLACE FUNCTION. Touches no table data
-- and none of the direct-applied prod objects (the FIFO trigger, fn_consume_fifo,
-- inventory_lots DDL). The scm supabase client is service-role, so no GRANT is
-- needed for it to call this (mirrors 0154 fn_reconcile_uncosted_out).
--
-- MIGRATION NUMBER: re-pick at MERGE time by re-listing migrations-pg/ — parallel
-- PRs collide on numbers (CLAUDE.md). pg-migrate tracks by filename; renaming an
-- applied file re-runs it, but this is CREATE OR REPLACE so a re-run is safe.
--
-- HOUZS CONVENTIONS — schema-qualified (scm.*) + SET search_path pinned to scm.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

CREATE OR REPLACE FUNCTION scm.fn_stock_transfer_apply(
  p_from_warehouse_id UUID,
  p_to_warehouse_id   UUID,
  p_source_doc_id     UUID,
  p_source_doc_no     TEXT,
  p_company_id        BIGINT,
  p_performed_by      UUID,
  -- Array of {product_code, product_name, variant_key, qty, batch_no}. qty is a
  -- positive count; variant_key '' = unclassified; batch_no null = plain FIFO.
  p_lines             JSONB
) RETURNS INTEGER            -- number of lines actually moved (qty > 0)
SET search_path = scm, pg_temp
AS $fn$
DECLARE
  v_line     JSONB;
  v_qty      INTEGER;
  v_variant  TEXT;
  v_batch    TEXT;
  v_out_id   UUID;
  v_out_qty  INTEGER;
  v_out_cost INTEGER;
  v_in_unit  INTEGER;
  v_moved    INTEGER := 0;
BEGIN
  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb))
  LOOP
    v_qty := FLOOR(COALESCE((v_line->>'qty')::numeric, 0))::integer;
    CONTINUE WHEN v_qty <= 0;                       -- mirror JS `if (ln.qty <= 0) continue`
    v_variant := COALESCE(v_line->>'variant_key', '');
    v_batch   := NULLIF(v_line->>'batch_no', '');   -- '' / absent -> NULL -> plain FIFO

    -- 1) OUT @ source. The AFTER-INSERT FIFO trigger consumes the source lots
    --    (FOR UPDATE row locks, held to txn end) and stamps this row's
    --    total_cost_sen via its own UPDATE — visible to us below in this same txn.
    INSERT INTO scm.inventory_movements (
      company_id, movement_type, warehouse_id, product_code, variant_key,
      product_name, qty, source_doc_type, source_doc_id, source_doc_no,
      batch_no, performed_by, notes
    ) VALUES (
      p_company_id, 'OUT', p_from_warehouse_id, v_line->>'product_code', v_variant,
      v_line->>'product_name', v_qty, 'STOCK_TRANSFER', p_source_doc_id, p_source_doc_no,
      v_batch, p_performed_by, 'Transfer to warehouse ' || p_to_warehouse_id::text
    ) RETURNING id INTO v_out_id;

    -- 2) Read the consumed cost the trigger just stamped (same txn sees its own
    --    writes) and derive the IN unit cost = weighted-avg of the source lots.
    SELECT qty, COALESCE(total_cost_sen, 0)
      INTO v_out_qty, v_out_cost
      FROM scm.inventory_movements
     WHERE id = v_out_id;
    v_in_unit := CASE WHEN v_out_qty > 0
                      THEN round(v_out_cost::numeric / v_out_qty)::integer
                      ELSE 0 END;

    -- 3) IN @ destination at that cost. The FIFO trigger opens the dest lot with
    --    the carried cost + batch. If THIS raises, the whole call (including the
    --    OUT above and every prior line) rolls back — stock is never half-moved.
    INSERT INTO scm.inventory_movements (
      company_id, movement_type, warehouse_id, product_code, variant_key,
      product_name, qty, unit_cost_sen, source_doc_type, source_doc_id, source_doc_no,
      batch_no, performed_by, notes
    ) VALUES (
      p_company_id, 'IN', p_to_warehouse_id, v_line->>'product_code', v_variant,
      v_line->>'product_name', v_qty, v_in_unit, 'STOCK_TRANSFER', p_source_doc_id, p_source_doc_no,
      v_batch, p_performed_by, 'Transfer from warehouse ' || p_from_warehouse_id::text
    );

    v_moved := v_moved + 1;
  END LOOP;

  RETURN v_moved;
END;
$fn$ LANGUAGE plpgsql;

COMMENT ON FUNCTION scm.fn_stock_transfer_apply(UUID, UUID, UUID, TEXT, BIGINT, UUID, JSONB) IS
  'Atomic inter-warehouse stock transfer (0192, audit R3). Writes every line''s OUT@source + IN@dest in ONE transaction: any failure rolls the whole transfer back so stock is never half-moved (source consumed but dest never created, or vice versa). Cost carry-over: the OUT''s AFTER-INSERT FIFO trigger stamps total_cost_sen from the consumed source lots; read back in-txn and applied as the IN''s unit_cost, so a transfer neither invents nor loses FIFO cost. Concurrency: fn_consume_fifo''s SELECT ... FOR UPDATE locks are held to txn end, serialising two transfers draining the same source bucket (no double-consume). Replaces the non-atomic JS OUT/re-read/IN/compensate saga in scm/routes/stock-transfers.ts.';
