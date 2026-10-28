-- 20261014T1430_scm_po_line_qty_floor.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_po_item_qty_floor ON scm.purchase_order_items;
--           DROP FUNCTION IF EXISTS scm.fn_po_item_qty_floor();
--   Purely a guard: it writes no row, so dropping it changes no stored data.
--   The app's received floor (ReceivedFloorError, lib/po-revision.ts and
--   reviseBoundPo) and the PO line-edit GRN lock are still in place.
--   GRANTS: none to re-apply — a trigger and a function only.
--
-- WHAT THIS CHANGES (HC-0004, the PO twin of 20261014T1420). A cut to a
--   Purchase Order line's qty that leaves it below what live GRNs have already
--   received is refused with SQLSTATE P0411, the same code and the same sum as
--   the PO -> GRN cap (scm.assert_po_line_not_over_received, 20261014T1400).
--
--   The app already refuses such a cut (ReceivedFloorError), but from a read
--   of purchase_order_items.received_qty taken BEFORE the write. A GRN posted
--   between that read and the line update slips through. This trigger runs the
--   cap under the same row lock the GRN-line trigger takes, so whichever write
--   comes second sees the first one and is refused.
--
--   ONLY A CUT IS CHECKED (WHEN NEW.qty < OLD.qty). A raise, a same-qty write
--   and every other column pass untouched, so the 11 PO lines already over by
--   +1 from the AutoCount import still take ordinary edits.
--
-- Verified against: tests-pg/poLineQtyFloor.pg.test.ts (postgres:16).

SET search_path TO scm, public;

CREATE OR REPLACE FUNCTION scm.fn_po_item_qty_floor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
BEGIN
  PERFORM scm.assert_po_line_not_over_received(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_po_item_qty_floor ON scm.purchase_order_items;
CREATE TRIGGER trg_po_item_qty_floor
  AFTER UPDATE OF qty ON scm.purchase_order_items
  FOR EACH ROW
  WHEN (NEW.qty < OLD.qty)
  EXECUTE FUNCTION scm.fn_po_item_qty_floor();
