-- 20261103T1600_scm_pwp_codes_follow_so_customer.sql (Postgres)
-- A PWP code follows its source order when the order's customer changes.
--
-- BUG (Hub 2990-0037, PWP-3473FBHD "code belongs to a different customer"):
-- SO 2990-SO-2611-009 was created with a typo'd name, which minted customer A;
-- the code was issued to A. Editing the name moved the SO to customer B but the
-- code stayed on A, so the customer could no longer redeem it. The only
-- re-point lived inside apply_so_header_cas and ran only when the request sent
-- recustomer=true; any other write of mfg_sales_orders.customer_id (a header
-- PATCH carrying customerId, the amendment apply, a script) left codes behind.
--
-- FIX. One trigger on the column, so EVERY path is covered: when customer_id
-- changes, the order's still-AVAILABLE codes that were on the old customer move
-- to the new one. REDEEMED / other statuses are history and are left alone.
-- Company-scoped on both sides. Codes already on some third customer are not
-- touched (customer_id = OLD.customer_id).
--
-- Existing stranded codes are NOT backfilled here (data fix, run by hand):
-- see backend/scripts/pwp-stranded-codes.sql.
--
-- REVERSAL:
--   DROP TRIGGER IF EXISTS pwp_codes_follow_so_customer ON scm.mfg_sales_orders;
--   DROP FUNCTION IF EXISTS scm.pwp_codes_follow_so_customer();

CREATE OR REPLACE FUNCTION scm.pwp_codes_follow_so_customer() RETURNS trigger
LANGUAGE plpgsql SET search_path = scm, pg_temp AS $$
BEGIN
  UPDATE scm.pwp_codes
  SET customer_id = NEW.customer_id, updated_at = now()
  WHERE source_doc_no = NEW.doc_no
    AND company_id = NEW.company_id
    AND status = 'AVAILABLE'
    AND customer_id IS NOT DISTINCT FROM OLD.customer_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS pwp_codes_follow_so_customer ON scm.mfg_sales_orders;
CREATE TRIGGER pwp_codes_follow_so_customer
  AFTER UPDATE OF customer_id ON scm.mfg_sales_orders
  FOR EACH ROW
  WHEN (NEW.customer_id IS NOT NULL AND OLD.customer_id IS DISTINCT FROM NEW.customer_id)
  EXECUTE FUNCTION scm.pwp_codes_follow_so_customer();
