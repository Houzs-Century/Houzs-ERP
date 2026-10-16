-- 20261014T1400_scm_po_line_over_receipt_guard.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_grn_item_po_over_receipt ON scm.grn_items;
--           DROP TRIGGER IF EXISTS trg_grn_status_po_over_receipt ON scm.grns;
--           DROP FUNCTION IF EXISTS scm.fn_grn_item_po_over_receipt();
--           DROP FUNCTION IF EXISTS scm.fn_grn_status_po_over_receipt();
--           DROP FUNCTION IF EXISTS scm.assert_po_line_not_over_received(uuid);
--   Purely a guard: it writes no row, so dropping it changes no stored data.
--   The app's read-then-write checks and post-insert rechecks are still in place.
--   GRANTS: none to re-apply — triggers and functions only.
--
-- WHAT THIS CHANGES (HC-0004 T3). The PO line -> GRN line cap moves into the
--   database, the same shape as the SO -> DO cap (20261014T1300). A write that
--   RAISES the live received total of a Purchase Order line past that line's qty
--   is refused with SQLSTATE P0411.
--
--   "Live" is the app's own rule, verifyGrnOverReceipt / recomputePoReceived:
--     Σ greatest(0, grn_items.qty_accepted − grn_items.returned_qty)
--       linked by purchase_order_item_id, on a GRN whose status is NOT
--       DRAFT / CANCELLED.
--   Lines with no purchase_order_item_id (manual receipts) are not capped.
--
--   ONLY AN INCREASE IS REFUSED. Prod has 11 PO lines already over by +1 from
--   the old AutoCount import. An edit to an unrelated column, a qty cut, a
--   cancel, or a post of a GRN with no lines on that PO line all pass, because
--   the trigger only checks when THIS row change adds to the line's live total.
--
--   returned_qty is NOT a trigger column. It is a rollup written after a
--   Purchase Return is created or cancelled (adjustGrnReturnedQty), best-effort;
--   refusing that write would leave the rollup stale while the return itself
--   commits. A cancelled return that pushes a PO line back over is therefore
--   allowed here (same call as a cancelled delivery return on the SO side).
--
-- WHY A ROW LOCK. Same as 20261014T1300: FOR NO KEY UPDATE on the parent PO
--   line, then re-sum. A second writer waits on that lock, and under READ
--   COMMITTED its next statement sees the first writer's committed line. NO KEY
--   UPDATE does not conflict with the FOR KEY SHARE an FK check takes, so two
--   concurrent inserts do not deadlock.
--
-- Verified against: tests-pg/poLineOverReceiptGuard.pg.test.ts (postgres:16).

SET search_path TO scm, public;

CREATE OR REPLACE FUNCTION scm.assert_po_line_not_over_received(p_po_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_qty      numeric;
  v_received numeric;
BEGIN
  SELECT p.qty INTO v_qty
    FROM scm.purchase_order_items p
   WHERE p.id = p_po_item_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(greatest(0, coalesce(i.qty_accepted, 0) - coalesce(i.returned_qty, 0))), 0)
    INTO v_received
    FROM scm.grn_items i
    JOIN scm.grns g ON g.id = i.grn_id
   WHERE i.purchase_order_item_id = p_po_item_id
     AND upper(g.status::text) NOT IN ('DRAFT', 'CANCELLED');

  IF v_received > coalesce(v_qty, 0) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0411',
      MESSAGE = format('po_line_over_received: PO line %s would have %s received against qty %s',
                       p_po_item_id, v_received, v_qty),
      DETAIL = p_po_item_id::text,
      HINT = 'Another goods received note already covers this Purchase Order line. Refresh and check the remaining qty.';
  END IF;
END;
$$;

-- A GRN line insert / qty raise / rebind / re-parent that adds to a live total.
CREATE OR REPLACE FUNCTION scm.fn_grn_item_po_over_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_new numeric := 0;
  v_old numeric := 0;
BEGIN
  IF NEW.purchase_order_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT greatest(0, coalesce(NEW.qty_accepted, 0) - coalesce(NEW.returned_qty, 0)) INTO v_new
    FROM scm.grns g
   WHERE g.id = NEW.grn_id
     AND upper(g.status::text) NOT IN ('DRAFT', 'CANCELLED');
  IF NOT FOUND THEN
    RETURN NULL; -- a DRAFT / CANCELLED GRN adds nothing; its post is checked below
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.purchase_order_item_id IS NOT DISTINCT FROM NEW.purchase_order_item_id THEN
    SELECT greatest(0, coalesce(OLD.qty_accepted, 0) - coalesce(OLD.returned_qty, 0)) INTO v_old
      FROM scm.grns g
     WHERE g.id = OLD.grn_id
       AND upper(g.status::text) NOT IN ('DRAFT', 'CANCELLED');
    IF NOT FOUND THEN
      v_old := 0;
    END IF;
  END IF;

  IF v_new > v_old THEN
    PERFORM scm.assert_po_line_not_over_received(NEW.purchase_order_item_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_grn_item_po_over_receipt ON scm.grn_items;
CREATE TRIGGER trg_grn_item_po_over_receipt
  AFTER INSERT OR UPDATE OF qty_accepted, purchase_order_item_id, grn_id ON scm.grn_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_grn_item_po_over_receipt();

-- A GRN entering a live status (DRAFT post, or an un-cancel) adds all its
-- linked lines at once. Drafts do not count, so two drafts on one PO line could
-- both be posted without this.
CREATE OR REPLACE FUNCTION scm.fn_grn_status_po_over_receipt()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_po_item_id uuid;
BEGIN
  -- Sorted, so two GRNs posting over the same PO lines lock them in one order.
  FOR v_po_item_id IN
    SELECT DISTINCT i.purchase_order_item_id
      FROM scm.grn_items i
     WHERE i.grn_id = NEW.id
       AND i.purchase_order_item_id IS NOT NULL
       AND coalesce(i.qty_accepted, 0) - coalesce(i.returned_qty, 0) > 0
     ORDER BY i.purchase_order_item_id
  LOOP
    PERFORM scm.assert_po_line_not_over_received(v_po_item_id);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_grn_status_po_over_receipt ON scm.grns;
CREATE TRIGGER trg_grn_status_po_over_receipt
  AFTER UPDATE OF status ON scm.grns
  FOR EACH ROW
  WHEN (upper(OLD.status::text) IN ('DRAFT', 'CANCELLED')
        AND upper(NEW.status::text) NOT IN ('DRAFT', 'CANCELLED'))
  EXECUTE FUNCTION scm.fn_grn_status_po_over_receipt();
