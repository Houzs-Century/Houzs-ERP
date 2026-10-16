-- 20261014T1310_scm_do_cancel_invoiced_lock.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_do_cancel_invoiced_lock ON scm.delivery_orders;
--           DROP FUNCTION IF EXISTS scm.fn_do_cancel_invoiced_lock();
--   Purely a guard: it writes no row, so dropping it changes no stored data.
--   The app check (doHasDownstream, now line-level) still refuses the cancel.
--   GRANTS: none to re-apply — a trigger and its function only.
--
-- WHAT THIS CHANGES (HC-0004 T2). A delivery order cannot move to CANCELLED
--   while a live (non-CANCELLED) Sales Invoice carries one of its lines
--   (sales_invoice_items.do_item_id) or names it on its header
--   (sales_invoices.delivery_order_id). Refused with SQLSTATE P0410.
--
-- WHY. An SI raised from several DOs stamps only the FIRST DO on its header
--   (si-from-do.ts), and appending DO lines to an SI does not change the header,
--   so the app's header-only check let the other DOs be cancelled under a live
--   invoice. The app check is now line-level too; this trigger is the atomic
--   half. It first takes FOR UPDATE on the DO's own lines, which waits for any
--   in-flight SI line insert (its FK check holds FOR KEY SHARE on the DO line),
--   so the EXISTS below then sees that SI line once it commits.
--
-- Verified against: tests-pg/doCancelInvoicedLock.pg.test.ts (postgres:16).

SET search_path TO scm, public;

CREATE OR REPLACE FUNCTION scm.fn_do_cancel_invoiced_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_si text;
BEGIN
  PERFORM 1 FROM scm.delivery_order_items i
   WHERE i.delivery_order_id = NEW.id
   ORDER BY i.id
     FOR UPDATE;

  SELECT coalesce(
    (SELECT si.id::text
       FROM scm.delivery_order_items i
       JOIN scm.sales_invoice_items sl ON sl.do_item_id = i.id
       JOIN scm.sales_invoices si ON si.id = sl.sales_invoice_id
      WHERE i.delivery_order_id = NEW.id
        AND upper(coalesce(si.status::text, '')) <> 'CANCELLED'
      LIMIT 1),
    (SELECT si.id::text
       FROM scm.sales_invoices si
      WHERE si.delivery_order_id = NEW.id
        AND upper(coalesce(si.status::text, '')) <> 'CANCELLED'
      LIMIT 1))
    INTO v_si;

  IF v_si IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0410',
      MESSAGE = format('do_has_live_invoice: delivery order %s is billed by live sales invoice %s', NEW.id, v_si),
      DETAIL = v_si,
      HINT = 'Cancel the Sales Invoice (or remove this delivery''s lines from it) first.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_do_cancel_invoiced_lock ON scm.delivery_orders;
CREATE TRIGGER trg_do_cancel_invoiced_lock
  BEFORE UPDATE OF status ON scm.delivery_orders
  FOR EACH ROW
  WHEN (upper(NEW.status::text) = 'CANCELLED' AND upper(OLD.status::text) <> 'CANCELLED')
  EXECUTE FUNCTION scm.fn_do_cancel_invoiced_lock();
