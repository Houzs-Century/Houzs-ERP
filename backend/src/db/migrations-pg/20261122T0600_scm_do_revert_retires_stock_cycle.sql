-- 20261122T0600_scm_do_revert_retires_stock_cycle.sql
--
-- A delivery order reverted to Draft and shipped again takes its stock out again.
--
-- THE DEFECT. Reverting a shipped DO to Draft (POST /delivery-orders-mfg/:id/revert)
-- returns its stock: fn_reverse_do_out (or the route fallback) writes balancing
-- rows tagged source_doc_type = 'ADJUSTMENT' + the DO's id, and its first OUT rows
-- stay tagged 'DO'. Shipping it again then deducts nothing: deductInventoryForDo
-- finds an OUT for the DO and stops, and uq_inv_mov_do_source_v2 would refuse a
-- second first-ship row for the same bucket anyway. A second revert would also do
-- nothing (fn_reverse_do_out stops when any ADJUSTMENT row for the DO exists).
-- Stock reads too high, with no warning.
--
-- THE FIX. scm.fn_retire_do_stock_cycle(p_do_id): once the stock has come back,
-- the whole ship-and-return cycle is retired. The DO's own 'DO' rows and its
-- 'ADJUSTMENT' reversal rows are re-tagged 'DO_REVERTED' (same source_doc_id /
-- source_doc_no, so the ledger still names the DO), and so are any lot
-- consumptions still attached to those rows. The cycle nets to zero and every
-- stock sum (inventory_balances, stock close, lots) adds rows regardless of tag,
-- so no balance moves. Every reader keyed on 'DO' / 'ADJUSTMENT' + the DO id
-- (deduct guard, resync, reversal, delivery returns, cost restamp, source-PO
-- trace, shipped-from stamp, committed shipments, nightly integrity) then sees
-- only the live shipment, which is what a Draft DO has: none.
--
-- Refused (check_violation) when the DO still has stock out that its reversal
-- rows do not return, so a failed reversal is never hidden by re-tagging.
-- Returns the number of movement rows re-tagged.
--
-- The header delete lock also counts retired rows: goods moved against the DO
-- even if they came back.
--
-- Safe: two CREATE OR REPLACE FUNCTION. No table, row, grant or trigger changes;
-- rows are only re-tagged when the route calls the function after a revert.
--
-- REVERSAL: DROP FUNCTION IF EXISTS scm.fn_retire_do_stock_cycle(uuid); and re-run
--   the CREATE OR REPLACE FUNCTION scm.fn_do_header_delete_lock block from
--   20260904T0800_scm_do_line_integrity_lock.sql. Rows already re-tagged stay
--   'DO_REVERTED' (they net to zero; re-tagging them back would re-block a re-ship).
-- Verified against: tests-pg/doRevertRetiresStockCycle.pg.test.ts (postgres:16).

CREATE OR REPLACE FUNCTION scm.fn_retire_do_stock_cycle(p_do_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_out      BIGINT; -- $
  v_returned BIGINT; -- $
  v_n        INTEGER; -- $
BEGIN
  SELECT COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN qty WHEN movement_type = 'IN' THEN -qty ELSE 0 END), 0)
    INTO v_out
    FROM scm.inventory_movements
   WHERE source_doc_type = 'DO' AND source_doc_id = p_do_id; -- $
  SELECT COALESCE(SUM(CASE WHEN movement_type = 'OUT' THEN -qty ELSE qty END), 0)
    INTO v_returned
    FROM scm.inventory_movements
   WHERE source_doc_type = 'ADJUSTMENT' AND source_doc_id = p_do_id; -- $
  IF v_out > v_returned THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('do_stock_cycle: delivery order %s still has %s unit(s) out that were not returned', p_do_id, v_out - v_returned); -- $
  END IF; -- $

  UPDATE scm.inventory_lot_consumptions c
     SET source_doc_type = 'DO_REVERTED'
    FROM scm.inventory_movements m
   WHERE c.movement_id = m.id
     AND m.source_doc_id = p_do_id
     AND m.source_doc_type IN ('DO', 'ADJUSTMENT')
     AND c.source_doc_type IN ('DO', 'ADJUSTMENT'); -- $

  UPDATE scm.inventory_movements
     SET source_doc_type = 'DO_REVERTED'
   WHERE source_doc_id = p_do_id
     AND source_doc_type IN ('DO', 'ADJUSTMENT'); -- $
  GET DIAGNOSTICS v_n = ROW_COUNT; -- $
  RETURN v_n; -- $
END; -- $
$function$;

CREATE OR REPLACE FUNCTION scm.fn_do_header_delete_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM scm.inventory_movements m
     WHERE m.source_doc_type::text IN ('DO', 'DO_REVERTED')
       AND (m.source_doc_no = OLD.do_number OR m.source_doc_id::text = OLD.id::text)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format('do_header_integrity: %s has inventory movements and cannot be deleted', OLD.do_number),
      HINT = 'Goods moved against this delivery order. Set status = CANCELLED instead of deleting the row.'; -- $
  END IF; -- $
  RETURN OLD; -- $
END; -- $
$$;
