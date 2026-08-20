-- 0310 — Drop the four DEAD customer-PO columns from scm.mfg_sales_orders.
--
-- WHAT. `po_doc_no`, `customer_po`, `customer_po_id`, `customer_po_date` on the
-- SO header are 0%-filled dead columns (owner ruling #2429: the canonical
-- customer reference is `ref`). This drops them. `customer_po_image_b64`,
-- `ref` and `customer_so_no` are NOT touched — image_b64 is out of scope, ref is
-- canonical, customer_so_no is the transitional fallback.
--
-- WHY IT NEEDS A VIEW RECREATE (the 0189 hazard). scm.mfg_sales_orders_with_payment_totals
-- projects all four columns by name, so a bare DROP COLUMN is refused. The cycle
-- is DROP INDEX -> DROP VIEW -> DROP COLUMNs -> CREATE VIEW (without the four) ->
-- RESTORE the view's owner + grants. A recreated view is a NEW object with an
-- EMPTY ACL: 0189 skipped the regrant and took the prod Sales Order list down for
-- every user (permission denied for the view), repaired only by 0190 + 0191. This
-- migration restores the grants in the SAME transaction, using 0191's proven
-- self-adapting copy from the never-dropped sibling scm.suppliers_with_derived_category.
--
-- WHY THE SIBLING COPY, not a literal GRANT list. The prod runtime queries the
-- view through a Hyperdrive role whose name lives in the Cloudflare connection
-- string and appears NOWHERE in this repo — guessing role names is how 0190
-- missed and prod stayed broken. The sibling was created in the same 0084 as the
-- original payment-totals view and has never been dropped, so its catalog ACL
-- still holds the exact grantee set the payment-totals view must have. The
-- census (see below) confirmed the two ACLs are byte-identical TODAY
-- (owner postgres; full privileges to postgres WITH GRANT OPTION and to
-- service_role), so the copy reproduces the observed state; copying is robust to
-- a future grantee the census could not name.
--
-- The trigram index trgm_mfg_so_po_doc_no is on po_doc_no (an ILIKE search index
-- for a column that is always empty) and is dropped with it.
--
-- REVERSAL: IRREVERSIBLE (DROP COLUMN discards data). Safe because the census
--   proved all four columns hold ZERO non-empty values across all 2830 SO rows —
--   there is nothing to lose. To reconstruct the SHAPE (not the data): re-add
--   the four columns (po_doc_no text, customer_po text, customer_po_id text,
--   customer_po_date date), recreate the trgm_mfg_so_po_doc_no gin/trgm index on
--   po_doc_no, and recreate the view WITH the four columns back in its SELECT and
--   its grants restored. The columns would come back EMPTY.
-- Verified against: production census run 32280818981 (2026-08-19, read-only, PR
--   #2508). Fill counts: po_doc_no=0, customer_po=0, customer_po_id=0,
--   customer_po_date=0 (of 2830 rows). Dependencies: exactly one view
--   (mfg_sales_orders_with_payment_totals) and one index (trgm_mfg_so_po_doc_no);
--   no constraints, functions or policies reference them.

BEGIN;

-- 1. the trigram search index on the dead po_doc_no.
DROP INDEX IF EXISTS scm.trgm_mfg_so_po_doc_no;

-- 2. the only view projecting the four columns.
DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals;

-- 3. drop the four dead columns (NOT customer_po_image_b64 / ref / customer_so_no).
ALTER TABLE scm.mfg_sales_orders
  DROP COLUMN IF EXISTS po_doc_no,
  DROP COLUMN IF EXISTS customer_po,
  DROP COLUMN IF EXISTS customer_po_id,
  DROP COLUMN IF EXISTS customer_po_date;

-- 4. recreate the view WITHOUT the four columns (0305 body, four lines removed).
CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
 SELECT so.doc_no,
    so.transfer_to,
    so.so_date,
    so.branding,
    so.debtor_code,
    so.debtor_name,
    so.agent,
    so.sales_location,
    so.ref,
    so.venue,
    so.venue_id,
    so.address1,
    so.address2,
    so.address3,
    so.address4,
    so.phone,
    so.mattress_sofa_sen,
    so.bedframe_sen,
    so.accessories_sen,
    so.others_sen,
    so.mattress_sofa_cost_sen,
    so.bedframe_cost_sen,
    so.accessories_cost_sen,
    so.others_cost_sen,
    so.service_sen,
    so.service_cost_sen,
    so.local_total_sen,
    so.balance_sen,
    so.total_cost_sen,
    so.total_revenue_sen,
    so.total_margin_sen,
    so.margin_pct_basis,
    so.line_count,
    so.fabric_tier_addon_sen,
    so.delivery_fee_sen,
    so.cross_category_source_doc_no,
    so.currency,
    so.status,
    so.remark2,
    so.remark3,
    so.remark4,
    so.note,
    so.proceeded_at,
    so.sales_exemption_expiry,
    so.customer_id,
    so.customer_state,
    so.customer_country,
    so.customer_po_image_b64,
    so.customer_so_no,
    so.hub_id,
    so.hub_name,
    so.customer_delivery_date,
    so.processing_date,
    so.linked_do_doc_no,
    so.ship_to_address,
    so.bill_to_address,
    so.install_to_address,
    so.subtotal_sen,
    so.overdue,
    so.email,
    so.customer_type,
    so.salesperson_id,
    so.city,
    so.postcode,
    so.building_type,
    so.emergency_contact_name,
    so.emergency_contact_phone,
    so.emergency_contact_relationship,
    so.target_date,
    so.signature_b64,
    so.slip_key,
    so.slip_state,
    so.payment_method,
    so.installment_months,
    so.merchant_provider,
    so.approval_code,
    so.payment_date,
    so.deposit_sen,
    so.paid_sen,
    so.created_at,
    so.created_by,
    so.updated_at,
    so.priority_rank,
    so.priority_set_at,
    so.priority_set_by,
    so.priority_reason,
    so.allocation_warehouse_id,
    so.slip_image_key,
    so.receipt_image_key,
    so.delivery_state,
    so.possession_date,
    so.house_type,
    so.replacement_disposal,
    so.referral,
    so.amend_date_from_customer,
    so.amended_delivery_date,
    so.amend_reason,
    so.revision,
    so.company_id,
    COALESCE(p.paid_total, 0::bigint) AS paid_total_sen,
    so.local_total_sen - COALESCE(p.paid_total, 0::bigint) AS balance_sen_live
   FROM scm.mfg_sales_orders so
     LEFT JOIN ( SELECT mfg_sales_order_payments.so_doc_no,
            sum(mfg_sales_order_payments.amount_sen) AS paid_total
           FROM scm.mfg_sales_order_payments
          GROUP BY mfg_sales_order_payments.so_doc_no) p ON p.so_doc_no = so.doc_no;

-- 5. RESTORE owner + grants (the 0191 self-adapting copy, generalised to every
-- privilege type). The recreated view above starts with an empty ACL; copy the
-- owner and the full grantee/privilege set from the never-dropped sibling that
-- shared the payment-totals view's original grants. Idempotent: GRANT and
-- ALTER ... OWNER TO the same values re-run as no-ops.
DO $$
DECLARE
  g record;
  sibling_owner text;
BEGIN
  SELECT viewowner INTO sibling_owner
    FROM pg_views
   WHERE schemaname = 'scm' AND viewname = 'suppliers_with_derived_category';

  IF sibling_owner IS NOT NULL THEN
    EXECUTE format(
      'ALTER VIEW scm.mfg_sales_orders_with_payment_totals OWNER TO %I',
      sibling_owner
    );
  END IF;

  FOR g IN
    SELECT DISTINCT grantee, privilege_type, is_grantable
      FROM information_schema.role_table_grants
     WHERE table_schema = 'scm'
       AND table_name = 'suppliers_with_derived_category'
       AND grantee <> 'PUBLIC'
  LOOP
    EXECUTE format(
      'GRANT %s ON scm.mfg_sales_orders_with_payment_totals TO %I%s',
      g.privilege_type,
      g.grantee,
      CASE WHEN g.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END
    );
  END LOOP;
END $$;

COMMIT;
