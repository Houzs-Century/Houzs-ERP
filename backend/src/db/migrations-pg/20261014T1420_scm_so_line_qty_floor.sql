-- 20261014T1420_scm_so_line_qty_floor.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_so_item_qty_floor ON scm.mfg_sales_order_items;
--           DROP FUNCTION IF EXISTS scm.fn_so_item_qty_floor();
--   Purely a guard: it writes no row, so dropping it changes no stored data.
--   The app's freeze (shared/so-line-freeze.ts, re-read by applySoAmendment)
--   is still in place.
--   GRANTS: none to re-apply — a trigger and a function only.
--
-- WHAT THIS CHANGES (HC-0004 T6). A cut to a Sales Order line's qty that leaves
--   it below what live delivery orders already ship is refused with SQLSTATE
--   P0409, the same code and the same sum as the SO -> DO cap
--   (scm.assert_so_line_not_over_delivered, 20261014T1300).
--
--   The app already refuses any change to a line a live DO or SI carries
--   (applySoAmendment re-reads the freeze before it writes). What it cannot see
--   is a DO created AFTER that read and before the amendment commits: the
--   amendment transaction locks only the SO header, and DO create takes no lock
--   on it. This trigger closes that window. It runs the cap under the same row
--   lock the DO-line trigger takes, so whichever write comes second sees the
--   first one and is refused.
--
--   ONLY A CUT IS CHECKED (WHEN NEW.qty < OLD.qty). A raise, a same-qty write
--   and every other column pass untouched, so the 8 SO lines already over their
--   qty (census 14 Oct 2026, run 38523852117) still take ordinary edits.
--
-- Verified against: tests-pg/soLineQtyFloor.pg.test.ts (postgres:16).

SET search_path TO scm, public;

CREATE OR REPLACE FUNCTION scm.fn_so_item_qty_floor()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
BEGIN
  PERFORM scm.assert_so_line_not_over_delivered(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_so_item_qty_floor ON scm.mfg_sales_order_items;
CREATE TRIGGER trg_so_item_qty_floor
  AFTER UPDATE OF qty ON scm.mfg_sales_order_items
  FOR EACH ROW
  WHEN (NEW.qty < OLD.qty)
  EXECUTE FUNCTION scm.fn_so_item_qty_floor();
