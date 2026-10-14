-- 20261014T1300_scm_so_line_over_delivery_guard.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_do_item_so_over_delivery ON scm.delivery_order_items;
--           DROP TRIGGER IF EXISTS trg_do_status_so_over_delivery ON scm.delivery_orders;
--           DROP FUNCTION IF EXISTS scm.fn_do_item_so_over_delivery();
--           DROP FUNCTION IF EXISTS scm.fn_do_status_so_over_delivery();
--           DROP FUNCTION IF EXISTS scm.assert_so_line_not_over_delivered(uuid);
--   Purely a guard: it writes no row, so dropping it changes no stored data.
--   The app's read-then-write checks and post-insert rechecks are still in place.
--   GRANTS: none to re-apply — triggers and functions only.
--
-- WHAT THIS CHANGES (HC-0004 T1). The SO line -> DO line cap moves into the
--   database, where every writer passes (POST /, /from-sos, add line, qty edit,
--   draft confirm, scripts). A write that RAISES the live delivered total of a
--   Sales Order line past that line's qty is refused with SQLSTATE P0409.
--
--   "Live" is the app's own rule, soDeliverableRemaining + doCountsAsDelivered:
--     Σ delivery_order_items.qty  linked by so_item_id, on a delivery order
--                                 whose status is NOT DRAFT / CANCELLED
--   − Σ delivery_return_items.qty_returned on those DO lines, whose delivery
--                                 return is NOT CANCELLED.
--   Lines with no so_item_id are not capped here (the app keeps its item-code
--   check for them).
--
--   ONLY AN INCREASE IS REFUSED. Prod census 14 Oct 2026 (run 38523852117):
--   8 HOUZS SO lines are already over (10 units, worst +2). An edit to an
--   unrelated column, a qty cut, a cancel, or a confirm of a DO with no lines on
--   that SO line all pass, because the trigger only checks when THIS row change
--   adds to the line's live total.
--
-- WHY A ROW LOCK. The guard takes FOR NO KEY UPDATE on the parent SO line, then
--   re-sums. A second writer waits on that lock, and under READ COMMITTED its
--   next statement sees the first writer's committed line, so two concurrent
--   writes cannot both fit into the last unit. NO KEY UPDATE rather than FOR
--   UPDATE: the FK on delivery_order_items.so_item_id takes FOR KEY SHARE on
--   the same row first, and FOR UPDATE would deadlock two concurrent inserts
--   against each other's KEY SHARE; NO KEY UPDATE does not conflict with it but
--   still serialises the guards.
--
-- Verified against: tests-pg/soLineOverDeliveryGuard.pg.test.ts (postgres:16).

SET search_path TO scm, public;

CREATE OR REPLACE FUNCTION scm.assert_so_line_not_over_delivered(p_so_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_qty       integer;
  v_delivered bigint;
  v_returned  bigint;
BEGIN
  SELECT s.qty INTO v_qty
    FROM scm.mfg_sales_order_items s
   WHERE s.id = p_so_item_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(i.qty), 0) INTO v_delivered
    FROM scm.delivery_order_items i
    JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
   WHERE i.so_item_id = p_so_item_id
     AND upper(d.status::text) NOT IN ('DRAFT', 'CANCELLED');

  SELECT coalesce(sum(r.qty_returned), 0) INTO v_returned
    FROM scm.delivery_return_items r
    JOIN scm.delivery_returns dr ON dr.id = r.delivery_return_id
    JOIN scm.delivery_order_items i ON i.id = r.do_item_id
    JOIN scm.delivery_orders d ON d.id = i.delivery_order_id
   WHERE i.so_item_id = p_so_item_id
     AND upper(d.status::text) NOT IN ('DRAFT', 'CANCELLED')
     AND upper(coalesce(dr.status::text, '')) <> 'CANCELLED';

  IF v_delivered - v_returned > v_qty THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0409',
      MESSAGE = format('so_line_over_delivered: SO line %s would have %s delivered against qty %s',
                       p_so_item_id, v_delivered - v_returned, v_qty),
      DETAIL = p_so_item_id::text,
      HINT = 'Another delivery order already covers this Sales Order line. Refresh and check the remaining qty.';
  END IF;
END;
$$;

-- A DO line insert / qty raise / rebind / re-parent that adds to a live total.
CREATE OR REPLACE FUNCTION scm.fn_do_item_so_over_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_new integer := 0;
  v_old integer := 0;
BEGIN
  IF NEW.so_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(NEW.qty, 0) INTO v_new
    FROM scm.delivery_orders d
   WHERE d.id = NEW.delivery_order_id
     AND upper(d.status::text) NOT IN ('DRAFT', 'CANCELLED');
  IF NOT FOUND THEN
    RETURN NULL; -- a DRAFT / CANCELLED DO adds nothing; its confirm is checked below
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.so_item_id IS NOT DISTINCT FROM NEW.so_item_id THEN
    SELECT coalesce(OLD.qty, 0) INTO v_old
      FROM scm.delivery_orders d
     WHERE d.id = OLD.delivery_order_id
       AND upper(d.status::text) NOT IN ('DRAFT', 'CANCELLED');
    IF NOT FOUND THEN
      v_old := 0;
    END IF;
  END IF;

  IF v_new > v_old THEN
    PERFORM scm.assert_so_line_not_over_delivered(NEW.so_item_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_do_item_so_over_delivery ON scm.delivery_order_items;
CREATE TRIGGER trg_do_item_so_over_delivery
  AFTER INSERT OR UPDATE OF qty, so_item_id, delivery_order_id ON scm.delivery_order_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_do_item_so_over_delivery();

-- A DO entering a live status (DRAFT confirm, or an un-cancel) adds all its
-- linked lines at once. Drafts do not count toward remaining, so two drafts on
-- one SO line could both be confirmed without this.
CREATE OR REPLACE FUNCTION scm.fn_do_status_so_over_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_so_item_id uuid;
BEGIN
  -- Sorted, so two DOs confirming over the same SO lines lock them in one order.
  FOR v_so_item_id IN
    SELECT DISTINCT i.so_item_id
      FROM scm.delivery_order_items i
     WHERE i.delivery_order_id = NEW.id
       AND i.so_item_id IS NOT NULL
       AND i.qty > 0
     ORDER BY i.so_item_id
  LOOP
    PERFORM scm.assert_so_line_not_over_delivered(v_so_item_id);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_do_status_so_over_delivery ON scm.delivery_orders;
CREATE TRIGGER trg_do_status_so_over_delivery
  AFTER UPDATE OF status ON scm.delivery_orders
  FOR EACH ROW
  WHEN (upper(OLD.status::text) IN ('DRAFT', 'CANCELLED')
        AND upper(NEW.status::text) NOT IN ('DRAFT', 'CANCELLED'))
  EXECUTE FUNCTION scm.fn_do_status_so_over_delivery();
