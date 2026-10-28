-- ----------------------------------------------------------------------------
-- 20260909T1001 — the Sales Order LIST can see who an order is shared with.
--
-- Companion to 20260909T1000, which put `collaborator_staff_ids` (input) and
-- `access_staff_ids` (derived: salesperson + collaborators) on
-- scm.mfg_sales_orders. The SO list does not read that table: it reads this
-- VIEW, which ENUMERATES its columns one by one, so a column the view does not
-- name does not exist as far as the list is concerned. Without this file the
-- grants would be written correctly, enforced correctly on the detail read, and
-- the shared orders would simply not appear in the co-owner's list — the one
-- screen the whole feature is for. Worse, the list's scope filter itself moves
-- onto `access_staff_ids`, so shipping T1000 without this file does not degrade
-- the list, it 500s it for every user. That is the SCM view trap, and it has a
-- COE: backend/docs/scm-view-trap-coe.md.
--
-- Separate file from 20260909T1000 for the same reason 0325 was separate from
-- 0324: that one is an ADD COLUMN that cannot fail, this one touches a view that
-- took production's Sales Order list down for every user once already.
--
-- `CREATE OR REPLACE VIEW`, NOT DROP + CREATE, AND THAT IS THE WHOLE SAFETY
-- ARGUMENT. Migration 0189 DROPped this view and recreated it, and the new
-- object came back with an EMPTY ACL — a recreated view is a new object and
-- inherits no GRANTs — which is how the Sales Order list went dead for everyone
-- and needed 0190 AND 0191 to repair. `CREATE OR REPLACE` never drops the
-- object, so the owner and every GRANT survive untouched. It is allowed to ADD
-- columns only at the END of the select list, which is exactly what this does:
-- every existing column keeps its name, type and position, byte for byte from
-- 0325 (the definition production is running), and the two new columns are
-- appended after held_by.
--
-- If a future edit ever needs to REORDER or RETYPE a column here, CREATE OR
-- REPLACE will refuse and the file must go back to DROP + CREATE — and then it
-- must carry the grant-restore block 0312 carries. Do not reach for DROP to
-- silence the refusal.
--
-- Verified against: the body below is derived from
-- backend/src/db/migrations-pg/0325_scm_so_payment_totals_view_carries_hold.sql
-- with one line appended; 0325 is the latest recreate of this view on main.
--
-- REVERSAL: re-run 0325's CREATE VIEW body (it is this one without the last
-- column). Ship it as a NEW migration; this file is checksummed the moment it
-- reaches prod. Reversing costs nothing but the sharing feature — no data lives
-- in the view.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

CREATE OR REPLACE VIEW scm.mfg_sales_orders_with_payment_totals AS
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
    so.local_total_sen - COALESCE(p.paid_total, 0::bigint) AS balance_sen_live,
    so.on_hold,
    so.hold_reason,
    so.held_at,
    so.held_by,
    so.collaborator_staff_ids,
    so.access_staff_ids
   FROM scm.mfg_sales_orders so
     LEFT JOIN ( SELECT mfg_sales_order_payments.so_doc_no,
            sum(mfg_sales_order_payments.amount_sen) AS paid_total
           FROM scm.mfg_sales_order_payments
          GROUP BY mfg_sales_order_payments.so_doc_no) p ON p.so_doc_no = so.doc_no;
