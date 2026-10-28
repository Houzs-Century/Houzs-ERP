-- 0189 — Retire the dead legacy column scm.mfg_sales_orders.processing_date.
--
-- WHY. The SO "Processing date" has ONE user-facing field, and its storage is
-- internal_expected_dd (owner 2026-07-24: one field only). PR #140 renamed only
-- the UI LABEL to "Processing date" while the value kept landing in
-- internal_expected_dd; the legacy snapshot column processing_date has had no
-- writer since, so it is NULL on every SO created or edited after #140. Readers
-- were patched to coalesce internal_expected_dd ?? processing_date (PR #1179),
-- but the second column kept confusing every new reader — see the BUG-HISTORY
-- 2026-07-24 processing_date entry for the blank-Processing-date incident it
-- caused. This migration ships in the SAME PR that removes every backend select
-- of the column (a PostgREST select naming a dropped column errors).
--
-- NOTE. scm.consignment_sales_orders.processing_date (mig 0153) is a DIFFERENT
-- table's own column and is untouched, as is the native sales module's
-- sales_entries.processing_date.

-- DEPENDENCY. The column is PROJECTED by the scm.mfg_sales_orders_with_payment_totals
-- view, so a bare DROP fails ("cannot drop column processing_date ... because other
-- objects depend on it"). #1191 shipped without handling that and BLOCKED every prod
-- + staging deploy from 2026-07-24 12:36 on (the migration runner aborts, so nothing
-- merged after #1191 — note-links #1198, and more — reached prod). Drop the view,
-- drop the column, recreate the view WITHOUT the column. The body below is the view's
-- LIVE definition (pg_get_viewdef) minus the one dropped line; readers already
-- coalesce to internal_expected_dd (#1179) and the backend no longer selects the
-- column, so the view's column set is otherwise unchanged.
DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals;

ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS processing_date;

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
    so.po_doc_no,
    so.venue,
    so.venue_id,
    so.address1,
    so.address2,
    so.address3,
    so.address4,
    so.phone,
    so.mattress_sofa_centi,
    so.bedframe_centi,
    so.accessories_centi,
    so.others_centi,
    so.mattress_sofa_cost_centi,
    so.bedframe_cost_centi,
    so.accessories_cost_centi,
    so.others_cost_centi,
    so.service_centi,
    so.service_cost_centi,
    so.local_total_centi,
    so.balance_centi,
    so.total_cost_centi,
    so.total_revenue_centi,
    so.total_margin_centi,
    so.margin_pct_basis,
    so.line_count,
    so.fabric_tier_addon_centi,
    so.delivery_fee_centi,
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
    so.customer_po,
    so.customer_po_id,
    so.customer_po_date,
    so.customer_po_image_b64,
    so.customer_so_no,
    so.hub_id,
    so.hub_name,
    so.customer_delivery_date,
    so.internal_expected_dd,
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
    so.deposit_centi,
    so.paid_centi,
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
    COALESCE(p.paid_total, 0::bigint) AS paid_total_centi,
    GREATEST(so.local_total_centi - COALESCE(p.paid_total, 0::bigint), 0::bigint) AS balance_centi_live
   FROM scm.mfg_sales_orders so
     LEFT JOIN ( SELECT mfg_sales_order_payments.so_doc_no,
            sum(mfg_sales_order_payments.amount_centi) AS paid_total
           FROM scm.mfg_sales_order_payments
          GROUP BY mfg_sales_order_payments.so_doc_no) p ON p.so_doc_no = so.doc_no;
