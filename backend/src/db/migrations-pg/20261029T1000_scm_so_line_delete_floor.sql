-- 20261029T1000_scm_so_line_delete_floor.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_so_item_delete_floor ON scm.mfg_sales_order_items;
--           DROP TRIGGER IF EXISTS trg_dr_cancel_so_over_delivery ON scm.delivery_returns;
--           DROP FUNCTION IF EXISTS scm.fn_so_item_delete_floor();
--           DROP FUNCTION IF EXISTS scm.fn_dr_cancel_so_over_delivery();
--   Purely a guard: it writes no row, so dropping it changes no stored data.
--   GRANTS: none to re-apply — triggers and functions only.
--
-- WHAT THIS CHANGES (HC-0004, review findings A and C of the T1 / T6 guards).
--
--   A. DELETING an SO line. The qty floor (20261014T1420) fires on UPDATE OF qty
--   only. Removing a line in an SO amendment is a DELETE, and
--   delivery_order_items.so_item_id is ON DELETE SET NULL: a DO that confirmed
--   after the app's freeze read, before the delete, ends with its line pointing
--   at no SO line at all (5 units shipped against nothing). A delete of an SO
--   line that a live (not DRAFT / CANCELLED) DO line points at is now refused
--   with SQLSTATE P0409, message so_line_over_delivered: (the text
--   so-amendments.ts already turns into its 409). The guard takes FOR NO KEY
--   UPDATE on the line first, the lock the DO-line and DO-status guards take, so
--   whichever of delete and DO-confirm comes second sees the first.
--   Every app delete path reads the freeze first and refuses a carried line;
--   this is only the backstop for the race after that read. A DRAFT or
--   CANCELLED DO line does not block (its link is still nulled, as today).
--
--   C. CANCELLING a Delivery Return. A return takes units off an SO line's live
--   delivered total, so a later DO can ship them again; cancelling the return
--   puts them back and could leave the total above qty (qty 10, DO1 ships 10,
--   DR returns 4, DO2 ships 4, cancel DR -> 14). Moving a DR to CANCELLED now
--   runs the same cap on every SO line it returned units against, refusing with
--   P0409. Only the cancel transition is checked (WHEN OLD <> CANCELLED AND
--   NEW = CANCELLED), and only lines with qty_returned > 0.
--
-- Verified against: tests-pg/soLineDeleteFloor.pg.test.ts (postgres:16).

SET search_path TO scm, public;

CREATE OR REPLACE FUNCTION scm.fn_so_item_delete_floor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
BEGIN
  PERFORM 1 FROM scm.mfg_sales_order_items s WHERE s.id = OLD.id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN OLD; -- already deleted by a concurrent writer; this DELETE matches nothing
  END IF;

  IF EXISTS (
    SELECT 1
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
     WHERE i.so_item_id = OLD.id
       AND upper(d.status::text) NOT IN ('DRAFT', 'CANCELLED')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0409',
      MESSAGE = format('so_line_over_delivered: SO line %s is carried by a live delivery order and cannot be deleted', OLD.id),
      DETAIL = OLD.id::text,
      HINT = 'A Delivery Order already ships this Sales Order line. Refresh and check the order.';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_so_item_delete_floor ON scm.mfg_sales_order_items;
CREATE TRIGGER trg_so_item_delete_floor
  BEFORE DELETE ON scm.mfg_sales_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_so_item_delete_floor();

CREATE OR REPLACE FUNCTION scm.fn_dr_cancel_so_over_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_so_item_id uuid;
BEGIN
  -- Sorted, so two cancels over the same SO lines lock them in one order.
  FOR v_so_item_id IN
    SELECT DISTINCT i.so_item_id
      FROM scm.delivery_return_items r
      JOIN scm.delivery_order_items i ON i.id = r.do_item_id
     WHERE r.delivery_return_id = NEW.id
       AND r.qty_returned > 0
       AND i.so_item_id IS NOT NULL
     ORDER BY i.so_item_id
  LOOP
    PERFORM scm.assert_so_line_not_over_delivered(v_so_item_id);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_dr_cancel_so_over_delivery ON scm.delivery_returns;
CREATE TRIGGER trg_dr_cancel_so_over_delivery
  AFTER UPDATE OF status ON scm.delivery_returns
  FOR EACH ROW
  WHEN (upper(coalesce(OLD.status::text, '')) <> 'CANCELLED'
        AND upper(coalesce(NEW.status::text, '')) = 'CANCELLED')
  EXECUTE FUNCTION scm.fn_dr_cancel_so_over_delivery();
