-- 20261014T1410_scm_billing_over_invoice_guard.sql
-- REVERSAL: DROP TRIGGER IF EXISTS trg_pi_item_grn_over_invoice ON scm.purchase_invoice_items;
--           DROP TRIGGER IF EXISTS trg_pi_status_grn_over_invoice ON scm.purchase_invoices;
--           DROP TRIGGER IF EXISTS trg_si_item_do_over_invoice ON scm.sales_invoice_items;
--           DROP TRIGGER IF EXISTS trg_si_status_do_over_invoice ON scm.sales_invoices;
--           DROP FUNCTION IF EXISTS scm.fn_pi_item_grn_over_invoice();
--           DROP FUNCTION IF EXISTS scm.fn_pi_status_grn_over_invoice();
--           DROP FUNCTION IF EXISTS scm.fn_si_item_do_over_invoice();
--           DROP FUNCTION IF EXISTS scm.fn_si_status_do_over_invoice();
--           DROP FUNCTION IF EXISTS scm.assert_grn_line_not_over_invoiced(uuid);
--           DROP FUNCTION IF EXISTS scm.assert_do_line_not_over_invoiced(uuid);
--   Purely a guard: it writes no row, so dropping it changes no stored data.
--   The app's read-then-write checks and post-insert rechecks are still in place.
--   GRANTS: none to re-apply — triggers and functions only.
--
-- WHAT THIS CHANGES (HC-0004 T4). The two billing caps move into the database,
--   the same shape as the SO -> DO cap (20261014T1300):
--
--   GRN line -> Purchase Invoice line, SQLSTATE P0412. The app's rule,
--   verifyGrnLinesNotOverInvoiced:
--     Σ purchase_invoice_items.qty linked by grn_item_id, on a PI whose status
--     is NOT DRAFT / CANCELLED   <=   grn_items.qty_accepted − returned_qty.
--
--   DO line -> Sales Invoice line, SQLSTATE P0413. The app's rule,
--   do-line-remaining.ts ('invoiceable'):
--     Σ sales_invoice_items.qty linked by do_item_id, on an SI whose status is
--     NOT CANCELLED (a DRAFT SI counts)   <=   delivery_order_items.qty
--     − Σ delivery_return_items.qty_returned on a return NOT CANCELLED.
--
--   Lines with no grn_item_id / do_item_id are not capped.
--
--   ONLY AN INCREASE IS REFUSED. Prod census 14 Oct 2026 (run 38523852117):
--   0 GRN lines and 0 DO lines are over in either company. The guard still only
--   checks when THIS row change adds to the line's live billed total, so an
--   unrelated edit, a cut or a cancel always passes.
--
-- WHY A ROW LOCK. Same as 20261014T1300: FOR NO KEY UPDATE on the source line,
--   then re-sum. NO KEY UPDATE does not conflict with the FOR KEY SHARE an FK
--   check takes, so two concurrent inserts do not deadlock. On the DO side it
--   does conflict with the FOR UPDATE that the DO-cancel lock (20261014T1310)
--   takes on the same lines, so a cancel and an SI line insert serialise.
--
-- Verified against: tests-pg/billingOverInvoiceGuard.pg.test.ts (postgres:16).

SET search_path TO scm, public;

-- ── GRN line -> PI ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION scm.assert_grn_line_not_over_invoiced(p_grn_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_cap      numeric;
  v_invoiced numeric;
BEGIN
  SELECT coalesce(g.qty_accepted, 0) - coalesce(g.returned_qty, 0) INTO v_cap
    FROM scm.grn_items g
   WHERE g.id = p_grn_item_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(i.qty), 0) INTO v_invoiced
    FROM scm.purchase_invoice_items i
    JOIN scm.purchase_invoices p ON p.id = i.purchase_invoice_id
   WHERE i.grn_item_id = p_grn_item_id
     AND upper(p.status::text) NOT IN ('DRAFT', 'CANCELLED');

  IF v_invoiced > v_cap THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0412',
      MESSAGE = format('grn_line_over_invoiced: GRN line %s would have %s invoiced against %s accepted',
                       p_grn_item_id, v_invoiced, v_cap),
      DETAIL = p_grn_item_id::text,
      HINT = 'Another purchase invoice already bills this goods received line. Refresh and check the remaining qty.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION scm.fn_pi_item_grn_over_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_new numeric := 0;
  v_old numeric := 0;
BEGIN
  IF NEW.grn_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(NEW.qty, 0) INTO v_new
    FROM scm.purchase_invoices p
   WHERE p.id = NEW.purchase_invoice_id
     AND upper(p.status::text) NOT IN ('DRAFT', 'CANCELLED');
  IF NOT FOUND THEN
    RETURN NULL; -- a DRAFT / CANCELLED PI bills nothing; its confirm is checked below
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.grn_item_id IS NOT DISTINCT FROM NEW.grn_item_id THEN
    SELECT coalesce(OLD.qty, 0) INTO v_old
      FROM scm.purchase_invoices p
     WHERE p.id = OLD.purchase_invoice_id
       AND upper(p.status::text) NOT IN ('DRAFT', 'CANCELLED');
    IF NOT FOUND THEN
      v_old := 0;
    END IF;
  END IF;

  IF v_new > v_old THEN
    PERFORM scm.assert_grn_line_not_over_invoiced(NEW.grn_item_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pi_item_grn_over_invoice ON scm.purchase_invoice_items;
CREATE TRIGGER trg_pi_item_grn_over_invoice
  AFTER INSERT OR UPDATE OF qty, grn_item_id, purchase_invoice_id ON scm.purchase_invoice_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_pi_item_grn_over_invoice();

-- A PI entering a live status (DRAFT confirm, or an un-cancel) bills all its
-- linked lines at once. Drafts do not count, so two drafts on one GRN line
-- could both be confirmed without this.
CREATE OR REPLACE FUNCTION scm.fn_pi_status_grn_over_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_grn_item_id uuid;
BEGIN
  -- Sorted, so two PIs confirming over the same GRN lines lock them in one order.
  FOR v_grn_item_id IN
    SELECT DISTINCT i.grn_item_id
      FROM scm.purchase_invoice_items i
     WHERE i.purchase_invoice_id = NEW.id
       AND i.grn_item_id IS NOT NULL
       AND i.qty > 0
     ORDER BY i.grn_item_id
  LOOP
    PERFORM scm.assert_grn_line_not_over_invoiced(v_grn_item_id);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_pi_status_grn_over_invoice ON scm.purchase_invoices;
CREATE TRIGGER trg_pi_status_grn_over_invoice
  AFTER UPDATE OF status ON scm.purchase_invoices
  FOR EACH ROW
  WHEN (upper(OLD.status::text) IN ('DRAFT', 'CANCELLED')
        AND upper(NEW.status::text) NOT IN ('DRAFT', 'CANCELLED'))
  EXECUTE FUNCTION scm.fn_pi_status_grn_over_invoice();

-- ── DO line -> SI ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION scm.assert_do_line_not_over_invoiced(p_do_item_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_qty      numeric;
  v_returned numeric;
  v_invoiced numeric;
BEGIN
  SELECT coalesce(d.qty, 0) INTO v_qty
    FROM scm.delivery_order_items d
   WHERE d.id = p_do_item_id
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT coalesce(sum(r.qty_returned), 0) INTO v_returned
    FROM scm.delivery_return_items r
    JOIN scm.delivery_returns dr ON dr.id = r.delivery_return_id
   WHERE r.do_item_id = p_do_item_id
     AND upper(coalesce(dr.status::text, '')) <> 'CANCELLED';

  SELECT coalesce(sum(i.qty), 0) INTO v_invoiced
    FROM scm.sales_invoice_items i
    JOIN scm.sales_invoices s ON s.id = i.sales_invoice_id
   WHERE i.do_item_id = p_do_item_id
     AND upper(coalesce(s.status::text, '')) <> 'CANCELLED';

  IF v_invoiced > v_qty - v_returned THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0413',
      MESSAGE = format('do_line_over_invoiced: DO line %s would have %s invoiced against %s delivered net of returns',
                       p_do_item_id, v_invoiced, v_qty - v_returned),
      DETAIL = p_do_item_id::text,
      HINT = 'Another sales invoice already bills this delivery order line. Refresh and check the remaining qty.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION scm.fn_si_item_do_over_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_new numeric := 0;
  v_old numeric := 0;
BEGIN
  IF NEW.do_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(NEW.qty, 0) INTO v_new
    FROM scm.sales_invoices s
   WHERE s.id = NEW.sales_invoice_id
     AND upper(coalesce(s.status::text, '')) <> 'CANCELLED';
  IF NOT FOUND THEN
    RETURN NULL; -- a CANCELLED SI bills nothing; its un-cancel is checked below
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.do_item_id IS NOT DISTINCT FROM NEW.do_item_id THEN
    SELECT coalesce(OLD.qty, 0) INTO v_old
      FROM scm.sales_invoices s
     WHERE s.id = OLD.sales_invoice_id
       AND upper(coalesce(s.status::text, '')) <> 'CANCELLED';
    IF NOT FOUND THEN
      v_old := 0;
    END IF;
  END IF;

  IF v_new > v_old THEN
    PERFORM scm.assert_do_line_not_over_invoiced(NEW.do_item_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_si_item_do_over_invoice ON scm.sales_invoice_items;
CREATE TRIGGER trg_si_item_do_over_invoice
  AFTER INSERT OR UPDATE OF qty, do_item_id, sales_invoice_id ON scm.sales_invoice_items
  FOR EACH ROW EXECUTE FUNCTION scm.fn_si_item_do_over_invoice();

CREATE OR REPLACE FUNCTION scm.fn_si_status_do_over_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $$
DECLARE
  v_do_item_id uuid;
BEGIN
  FOR v_do_item_id IN
    SELECT DISTINCT i.do_item_id
      FROM scm.sales_invoice_items i
     WHERE i.sales_invoice_id = NEW.id
       AND i.do_item_id IS NOT NULL
       AND i.qty > 0
     ORDER BY i.do_item_id
  LOOP
    PERFORM scm.assert_do_line_not_over_invoiced(v_do_item_id);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_si_status_do_over_invoice ON scm.sales_invoices;
CREATE TRIGGER trg_si_status_do_over_invoice
  AFTER UPDATE OF status ON scm.sales_invoices
  FOR EACH ROW
  WHEN (upper(OLD.status::text) = 'CANCELLED' AND upper(NEW.status::text) <> 'CANCELLED')
  EXECUTE FUNCTION scm.fn_si_status_do_over_invoice();
