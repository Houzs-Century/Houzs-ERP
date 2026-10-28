-- 0305 money-unify: rename every scm _centi money column to _sen.
-- REVERSAL: rename each _sen column back to _centi (the RENAME statements swapped),
--   drop the recreated views/functions and recreate them from the _centi bodies.
--   GRANTS: the 11 dropped views carry NO explicit role grants (verified against
--   production 2026-08-18 via information_schema.role_table_grants — every one
--   returned NONE), so the recreated views restore the same empty ACL and there
--   is no grant to re-apply. This is the check 0189 failed: there it was a
--   granted view; here the census proves there is nothing to lose.
-- Verified against: production scm schema census 2026-08-18 (291 base+view columns, 70 tables, 11 views, 1 matview, 2 functions).

BEGIN;

-- ── views first: drop (they depend on the columns being renamed) ──
-- The mv_ar_aging MATERIALIZED VIEW depends on five of the outstanding views, so
-- it must be dropped before them (it lives in pg_matviews, not information_schema
-- .views, which is why the first cut of this migration missed it). Recreated with
-- its unique index at the end. No grants (census verified), like the plain views.
DROP MATERIALIZED VIEW IF EXISTS scm.mv_ar_aging;
DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals;
DROP VIEW IF EXISTS scm.v_ap_aging;
DROP VIEW IF EXISTS scm.v_ar_aging;
DROP VIEW IF EXISTS scm.v_customer_credit_balances;
DROP VIEW IF EXISTS scm.v_inventory_all_skus;
DROP VIEW IF EXISTS scm.v_inventory_product_totals;
DROP VIEW IF EXISTS scm.v_pi_outstanding;
DROP VIEW IF EXISTS scm.v_po_outstanding;
DROP VIEW IF EXISTS scm.v_pr_outstanding;
DROP VIEW IF EXISTS scm.v_si_outstanding;
DROP VIEW IF EXISTS scm.v_so_outstanding;

-- ── rename 251 base-table money columns ──
ALTER TABLE scm.consignment_delivery_order_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.consignment_delivery_order_items RENAME COLUMN line_cost_centi TO line_cost_sen;
ALTER TABLE scm.consignment_delivery_order_items RENAME COLUMN line_margin_centi TO line_margin_sen;
ALTER TABLE scm.consignment_delivery_order_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.consignment_delivery_order_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.consignment_delivery_order_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.consignment_delivery_order_payments RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN accessories_centi TO accessories_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN accessories_cost_centi TO accessories_cost_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN bedframe_centi TO bedframe_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN bedframe_cost_centi TO bedframe_cost_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN local_total_centi TO local_total_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN mattress_sofa_centi TO mattress_sofa_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN mattress_sofa_cost_centi TO mattress_sofa_cost_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN others_centi TO others_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN others_cost_centi TO others_cost_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN total_cost_centi TO total_cost_sen;
ALTER TABLE scm.consignment_delivery_orders RENAME COLUMN total_margin_centi TO total_margin_sen;
ALTER TABLE scm.consignment_delivery_return_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.consignment_delivery_return_items RENAME COLUMN line_cost_centi TO line_cost_sen;
ALTER TABLE scm.consignment_delivery_return_items RENAME COLUMN line_margin_centi TO line_margin_sen;
ALTER TABLE scm.consignment_delivery_return_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.consignment_delivery_return_items RENAME COLUMN refund_centi TO refund_sen;
ALTER TABLE scm.consignment_delivery_return_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.consignment_delivery_return_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN accessories_centi TO accessories_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN accessories_cost_centi TO accessories_cost_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN bedframe_centi TO bedframe_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN bedframe_cost_centi TO bedframe_cost_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN local_total_centi TO local_total_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN mattress_sofa_centi TO mattress_sofa_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN mattress_sofa_cost_centi TO mattress_sofa_cost_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN others_centi TO others_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN others_cost_centi TO others_cost_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN refund_centi TO refund_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN total_cost_centi TO total_cost_sen;
ALTER TABLE scm.consignment_delivery_returns RENAME COLUMN total_margin_centi TO total_margin_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN balance_centi TO balance_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN line_cost_centi TO line_cost_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN line_margin_centi TO line_margin_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN total_inc_centi TO total_inc_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.consignment_sales_order_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.consignment_sales_order_payments RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN accessories_centi TO accessories_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN accessories_cost_centi TO accessories_cost_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN balance_centi TO balance_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN bedframe_centi TO bedframe_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN bedframe_cost_centi TO bedframe_cost_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN delivery_fee_centi TO delivery_fee_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN deposit_centi TO deposit_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN fabric_tier_addon_centi TO fabric_tier_addon_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN local_total_centi TO local_total_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN mattress_sofa_centi TO mattress_sofa_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN mattress_sofa_cost_centi TO mattress_sofa_cost_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN others_centi TO others_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN others_cost_centi TO others_cost_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN paid_centi TO paid_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN total_cost_centi TO total_cost_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN total_margin_centi TO total_margin_sen;
ALTER TABLE scm.consignment_sales_orders RENAME COLUMN total_revenue_centi TO total_revenue_sen;
ALTER TABLE scm.customer_credits RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.delivery_order_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.delivery_order_items RENAME COLUMN line_cost_centi TO line_cost_sen;
ALTER TABLE scm.delivery_order_items RENAME COLUMN line_margin_centi TO line_margin_sen;
ALTER TABLE scm.delivery_order_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.delivery_order_items RENAME COLUMN ship_cost_centi TO ship_cost_sen;
ALTER TABLE scm.delivery_order_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.delivery_order_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN accessories_centi TO accessories_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN accessories_cost_centi TO accessories_cost_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN bedframe_centi TO bedframe_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN bedframe_cost_centi TO bedframe_cost_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN local_total_centi TO local_total_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN mattress_sofa_centi TO mattress_sofa_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN mattress_sofa_cost_centi TO mattress_sofa_cost_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN others_centi TO others_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN others_cost_centi TO others_cost_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN service_centi TO service_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN service_cost_centi TO service_cost_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN total_cost_centi TO total_cost_sen;
ALTER TABLE scm.delivery_orders RENAME COLUMN total_margin_centi TO total_margin_sen;
ALTER TABLE scm.delivery_rate_cards RENAME COLUMN cap_centi TO cap_sen;
ALTER TABLE scm.delivery_rate_cards RENAME COLUMN min_charge_centi TO min_charge_sen;
ALTER TABLE scm.delivery_rate_rules RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.delivery_return_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.delivery_return_items RENAME COLUMN line_cost_centi TO line_cost_sen;
ALTER TABLE scm.delivery_return_items RENAME COLUMN line_margin_centi TO line_margin_sen;
ALTER TABLE scm.delivery_return_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.delivery_return_items RENAME COLUMN refund_centi TO refund_sen;
ALTER TABLE scm.delivery_return_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.delivery_return_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN accessories_centi TO accessories_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN accessories_cost_centi TO accessories_cost_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN bedframe_centi TO bedframe_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN bedframe_cost_centi TO bedframe_cost_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN local_total_centi TO local_total_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN mattress_sofa_centi TO mattress_sofa_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN mattress_sofa_cost_centi TO mattress_sofa_cost_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN others_centi TO others_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN others_cost_centi TO others_cost_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN refund_centi TO refund_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN total_cost_centi TO total_cost_sen;
ALTER TABLE scm.delivery_returns RENAME COLUMN total_margin_centi TO total_margin_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN last_month_usage_centi TO last_month_usage_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN one_month_usage_centi TO one_month_usage_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN one_week_usage_centi TO one_week_usage_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN po_outstanding_centi TO po_outstanding_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN price_centi TO price_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN reorder_point_centi TO reorder_point_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN shortage_centi TO shortage_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN soh_centi TO soh_sen;
ALTER TABLE scm.fabric_trackings RENAME COLUMN two_weeks_usage_centi TO two_weeks_usage_sen;
ALTER TABLE scm.fabrics RENAME COLUMN reorder_level_centi TO reorder_level_sen;
ALTER TABLE scm.fabrics RENAME COLUMN soh_meters_centi TO soh_meters_sen;
ALTER TABLE scm.grn_items RENAME COLUMN allocated_charge_centi TO allocated_charge_sen;
ALTER TABLE scm.grn_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.grn_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.grn_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.grn_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.grns RENAME COLUMN subtotal_centi TO subtotal_sen;
ALTER TABLE scm.grns RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.grns RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.hr_commission_config RENAME COLUMN personal_kpi_threshold_centi TO personal_kpi_threshold_sen;
ALTER TABLE scm.hr_commission_config RENAME COLUMN showroom_kpi_threshold_centi TO showroom_kpi_threshold_sen;
ALTER TABLE scm.hr_item_kpi RENAME COLUMN bonus_centi TO bonus_sen;
ALTER TABLE scm.hr_payout_periods RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.hr_payout_rows RENAME COLUMN item_kpi_centi TO item_kpi_sen;
ALTER TABLE scm.hr_payout_rows RENAME COLUMN override_commission_centi TO override_commission_sen;
ALTER TABLE scm.hr_payout_rows RENAME COLUMN personal_commission_centi TO personal_commission_sen;
ALTER TABLE scm.hr_payout_rows RENAME COLUMN personal_goods_centi TO personal_goods_sen;
ALTER TABLE scm.hr_payout_rows RENAME COLUMN showroom_goods_centi TO showroom_goods_sen;
ALTER TABLE scm.hr_payout_rows RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.lorries RENAME COLUMN max_revenue_centi TO max_revenue_sen;
ALTER TABLE scm.lorries RENAME COLUMN purchase_price_centi TO purchase_price_sen;
ALTER TABLE scm.lorry_breakdown_cases RENAME COLUMN towing_cost_centi TO towing_cost_sen;
ALTER TABLE scm.lorry_compliance_documents RENAME COLUMN cost_centi TO cost_sen;
ALTER TABLE scm.lorry_component_events RENAME COLUMN cost_centi TO cost_sen;
ALTER TABLE scm.lorry_components RENAME COLUMN purchase_price_centi TO purchase_price_sen;
ALTER TABLE scm.lorry_maintenance_plans RENAME COLUMN est_cost_centi TO est_cost_sen;
ALTER TABLE scm.lorry_service_records RENAME COLUMN cost_centi TO cost_sen;
ALTER TABLE scm.lorry_work_order_parts RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.lorry_work_order_parts RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.lorry_work_orders RENAME COLUMN labour_centi TO labour_sen;
ALTER TABLE scm.lorry_work_orders RENAME COLUMN outside_service_centi TO outside_service_sen;
ALTER TABLE scm.lorry_work_orders RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.lorry_work_orders RENAME COLUMN towing_centi TO towing_sen;
ALTER TABLE scm.mfg_products RENAME COLUMN fabric_usage_centi TO fabric_usage_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN balance_centi TO balance_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN line_cost_centi TO line_cost_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN line_margin_centi TO line_margin_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN total_inc_centi TO total_inc_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.mfg_sales_order_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.mfg_sales_order_payments RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN accessories_centi TO accessories_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN accessories_cost_centi TO accessories_cost_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN balance_centi TO balance_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN bedframe_centi TO bedframe_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN bedframe_cost_centi TO bedframe_cost_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN delivery_fee_centi TO delivery_fee_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN deposit_centi TO deposit_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN fabric_tier_addon_centi TO fabric_tier_addon_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN local_total_centi TO local_total_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN mattress_sofa_centi TO mattress_sofa_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN mattress_sofa_cost_centi TO mattress_sofa_cost_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN others_centi TO others_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN others_cost_centi TO others_cost_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN paid_centi TO paid_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN service_centi TO service_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN service_cost_centi TO service_cost_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN total_cost_centi TO total_cost_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN total_margin_centi TO total_margin_sen;
ALTER TABLE scm.mfg_sales_orders RENAME COLUMN total_revenue_centi TO total_revenue_sen;
ALTER TABLE scm.payment_voucher_lines RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.payment_vouchers RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.po_amendment_lines RENAME COLUMN new_unit_price_centi TO new_unit_price_sen;
ALTER TABLE scm.product_dept_configs RENAME COLUMN fabric_usage_centi TO fabric_usage_sen;
ALTER TABLE scm.purchase_consignment_order_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.purchase_consignment_order_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.purchase_consignment_order_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.purchase_consignment_order_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.purchase_consignment_orders RENAME COLUMN subtotal_centi TO subtotal_sen;
ALTER TABLE scm.purchase_consignment_orders RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.purchase_consignment_orders RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.purchase_consignment_receive_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.purchase_consignment_receive_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.purchase_consignment_receive_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.purchase_consignment_receive_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.purchase_consignment_receives RENAME COLUMN subtotal_centi TO subtotal_sen;
ALTER TABLE scm.purchase_consignment_receives RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.purchase_consignment_receives RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.purchase_consignment_return_items RENAME COLUMN line_refund_centi TO line_refund_sen;
ALTER TABLE scm.purchase_consignment_return_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.purchase_consignment_returns RENAME COLUMN refund_centi TO refund_sen;
ALTER TABLE scm.purchase_invoice_items RENAME COLUMN allocated_charge_centi TO allocated_charge_sen;
ALTER TABLE scm.purchase_invoice_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.purchase_invoice_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.purchase_invoice_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.purchase_invoice_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.purchase_invoices RENAME COLUMN paid_centi TO paid_sen;
ALTER TABLE scm.purchase_invoices RENAME COLUMN subtotal_centi TO subtotal_sen;
ALTER TABLE scm.purchase_invoices RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.purchase_invoices RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.purchase_order_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.purchase_order_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.purchase_order_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.purchase_order_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.purchase_orders RENAME COLUMN subtotal_centi TO subtotal_sen;
ALTER TABLE scm.purchase_orders RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.purchase_orders RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.purchase_return_items RENAME COLUMN line_refund_centi TO line_refund_sen;
ALTER TABLE scm.purchase_return_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.purchase_returns RENAME COLUMN refund_centi TO refund_sen;
ALTER TABLE scm.pv_allocations RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.pv_allocations RENAME COLUMN applied_centi TO applied_sen;
ALTER TABLE scm.sales_invoice_items RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.sales_invoice_items RENAME COLUMN line_cost_centi TO line_cost_sen;
ALTER TABLE scm.sales_invoice_items RENAME COLUMN line_margin_centi TO line_margin_sen;
ALTER TABLE scm.sales_invoice_items RENAME COLUMN line_total_centi TO line_total_sen;
ALTER TABLE scm.sales_invoice_items RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.sales_invoice_items RENAME COLUMN unit_cost_centi TO unit_cost_sen;
ALTER TABLE scm.sales_invoice_items RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.sales_invoice_payments RENAME COLUMN amount_centi TO amount_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN accessories_centi TO accessories_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN accessories_cost_centi TO accessories_cost_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN bedframe_centi TO bedframe_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN bedframe_cost_centi TO bedframe_cost_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN discount_centi TO discount_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN local_total_centi TO local_total_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN mattress_sofa_centi TO mattress_sofa_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN mattress_sofa_cost_centi TO mattress_sofa_cost_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN others_centi TO others_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN others_cost_centi TO others_cost_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN paid_centi TO paid_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN service_centi TO service_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN service_cost_centi TO service_cost_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN subtotal_centi TO subtotal_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN tax_centi TO tax_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN total_centi TO total_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN total_cost_centi TO total_cost_sen;
ALTER TABLE scm.sales_invoices RENAME COLUMN total_margin_centi TO total_margin_sen;
ALTER TABLE scm.supplier_material_bindings RENAME COLUMN unit_price_centi TO unit_price_sen;
ALTER TABLE scm.trip_stops RENAME COLUMN revenue_centi TO revenue_sen;
ALTER TABLE scm.trips RENAME COLUMN three_pl_cost_centi TO three_pl_cost_sen;

-- ── recreate the 11 views with _sen names ──
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
    so.customer_po,
    so.customer_po_id,
    so.customer_po_date,
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

CREATE VIEW scm.v_ap_aging AS
 SELECT p.id AS invoice_id,
    p.invoice_number,
    p.supplier_invoice_ref,
    p.supplier_id,
    sup.code AS supplier_code,
    sup.name AS supplier_name,
    p.invoice_date,
    p.due_date,
    p.total_sen,
    p.paid_sen,
    p.total_sen - p.paid_sen AS outstanding_sen,
        CASE
            WHEN p.due_date IS NULL OR p.due_date >= CURRENT_DATE THEN 0
            ELSE CURRENT_DATE - p.due_date
        END AS days_overdue,
        CASE
            WHEN p.due_date IS NULL OR p.due_date >= CURRENT_DATE THEN 'CURRENT'::text
            WHEN (CURRENT_DATE - p.due_date) >= 1 AND (CURRENT_DATE - p.due_date) <= 30 THEN '1-30'::text
            WHEN (CURRENT_DATE - p.due_date) >= 31 AND (CURRENT_DATE - p.due_date) <= 60 THEN '31-60'::text
            WHEN (CURRENT_DATE - p.due_date) >= 61 AND (CURRENT_DATE - p.due_date) <= 90 THEN '61-90'::text
            ELSE '90+'::text
        END AS aging_bucket,
    p.status,
    p.company_id
   FROM scm.purchase_invoices p
     LEFT JOIN scm.suppliers sup ON sup.id = p.supplier_id
  WHERE p.total_sen > p.paid_sen AND (p.status <> ALL (ARRAY['CANCELLED'::scm.purchase_invoice_status, 'VOID'::scm.purchase_invoice_status]));

CREATE VIEW scm.v_ar_aging AS
 SELECT id AS invoice_id,
    invoice_number,
    debtor_code,
    debtor_name,
    invoice_date,
    due_date,
    total_sen,
    paid_sen,
    total_sen - paid_sen AS outstanding_sen,
        CASE
            WHEN due_date IS NULL OR due_date >= CURRENT_DATE THEN 0
            ELSE CURRENT_DATE - due_date
        END AS days_overdue,
        CASE
            WHEN due_date IS NULL OR due_date >= CURRENT_DATE THEN 'CURRENT'::text
            WHEN (CURRENT_DATE - due_date) >= 1 AND (CURRENT_DATE - due_date) <= 30 THEN '1-30'::text
            WHEN (CURRENT_DATE - due_date) >= 31 AND (CURRENT_DATE - due_date) <= 60 THEN '31-60'::text
            WHEN (CURRENT_DATE - due_date) >= 61 AND (CURRENT_DATE - due_date) <= 90 THEN '61-90'::text
            ELSE '90+'::text
        END AS aging_bucket,
    status,
    company_id
   FROM scm.sales_invoices s
  WHERE total_sen > paid_sen AND (status <> ALL (ARRAY['CANCELLED'::scm.sales_invoice_status, 'VOID'::scm.sales_invoice_status]));

CREATE VIEW scm.v_customer_credit_balances AS
 SELECT debtor_code,
    max(debtor_name) AS debtor_name,
    sum(amount_sen) AS balance_sen,
    count(*) AS entry_count,
    max(created_at) AS last_entry_at
   FROM scm.customer_credits
  GROUP BY debtor_code;

CREATE VIEW scm.v_inventory_all_skus AS
 SELECT p.code AS product_code,
    p.name AS product_name,
    p.category,
    p.size_label,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    w.name AS warehouse_name,
    COALESCE(b.qty, 0::numeric) AS qty,
    b.last_movement_at,
    COALESCE(v.value_sen, 0::bigint) AS value_sen,
    ms.supplier_code AS main_supplier_code,
    ms.supplier_name AS main_supplier_name,
    ms.unit_price_sen AS main_supplier_price_sen,
    w.company_id
   FROM scm.mfg_products p
     CROSS JOIN scm.warehouses w
     LEFT JOIN ( SELECT inventory_balances.warehouse_id,
            inventory_balances.product_code,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.warehouse_id, inventory_balances.product_code) b ON b.warehouse_id = w.id AND b.product_code = p.code
     LEFT JOIN ( SELECT inventory_lots.warehouse_id,
            inventory_lots.product_code,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.warehouse_id, inventory_lots.product_code) v ON v.warehouse_id = w.id AND v.product_code = p.code
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_sen
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.material_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_sen
         LIMIT 1) ms ON true
  WHERE w.is_active = true AND p.status = 'ACTIVE'::scm.mfg_product_status AND p.company_id = w.company_id;

CREATE VIEW scm.v_inventory_product_totals AS
 SELECT p.code AS product_code,
    p.name AS product_name,
    p.category,
    p.size_label,
    p.base_price_sen,
    p.price1_sen,
    p.branding,
    COALESCE(b.qty, 0::numeric) AS total_qty,
    COALESCE(v.value_sen, 0::bigint) AS total_value_sen,
    b.last_movement_at,
    ms.supplier_code AS main_supplier_code,
    ms.supplier_name AS main_supplier_name,
    ms.unit_price_sen AS main_supplier_price_sen,
    p.company_id
   FROM scm.mfg_products p
     LEFT JOIN ( SELECT inventory_balances.product_code,
            inventory_balances.company_id,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.product_code, inventory_balances.company_id) b ON b.product_code = p.code AND b.company_id = p.company_id
     LEFT JOIN ( SELECT inventory_lots.product_code,
            inventory_lots.company_id,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.product_code, inventory_lots.company_id) v ON v.product_code = p.code AND v.company_id = p.company_id
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_sen
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.material_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_sen
         LIMIT 1) ms ON true
  WHERE p.status = 'ACTIVE'::scm.mfg_product_status;

CREATE VIEW scm.v_pi_outstanding AS
 SELECT id,
    invoice_number,
    supplier_invoice_ref,
    supplier_id,
    invoice_date,
    due_date,
    total_sen,
    paid_sen,
    total_sen - paid_sen AS outstanding_sen,
    status,
        CASE
            WHEN status = ANY (ARRAY['PAID'::scm.purchase_invoice_status, 'CANCELLED'::scm.purchase_invoice_status]) THEN false
            WHEN total_sen > paid_sen THEN true
            ELSE false
        END AS is_outstanding,
    company_id
   FROM scm.purchase_invoices pi;

CREATE VIEW scm.v_po_outstanding AS
 SELECT po.id,
    po.po_number,
    po.supplier_id,
    po.po_date,
    po.expected_at,
    po.currency,
    po.subtotal_sen,
    po.total_sen,
    po.status,
    COALESCE(sum(poi.qty), 0::bigint) AS qty_ordered,
    COALESCE(sum(poi.received_qty), 0::bigint) AS qty_received,
    COALESCE(sum(poi.qty), 0::bigint) - COALESCE(sum(poi.received_qty), 0::bigint) AS qty_outstanding,
        CASE
            WHEN po.status = ANY (ARRAY['RECEIVED'::scm.po_status, 'CANCELLED'::scm.po_status]) THEN false
            WHEN COALESCE(sum(poi.qty), 0::bigint) > COALESCE(sum(poi.received_qty), 0::bigint) THEN true
            ELSE false
        END AS is_outstanding,
    po.company_id
   FROM scm.purchase_orders po
     LEFT JOIN scm.purchase_order_items poi ON poi.purchase_order_id = po.id
  GROUP BY po.id;

CREATE VIEW scm.v_pr_outstanding AS
 SELECT id,
    return_number,
    supplier_id,
    return_date,
    status,
    refund_sen,
        CASE
            WHEN status = ANY (ARRAY['COMPLETED'::scm.purchase_return_status, 'CANCELLED'::scm.purchase_return_status]) THEN false
            ELSE true
        END AS is_outstanding,
    company_id
   FROM scm.purchase_returns pr;

CREATE VIEW scm.v_si_outstanding AS
 SELECT id,
    invoice_number,
    so_doc_no,
    delivery_order_id,
    debtor_code,
    debtor_name,
    invoice_date,
    due_date,
    total_sen,
    paid_sen,
    total_sen - paid_sen AS outstanding_sen,
    status,
        CASE
            WHEN status = ANY (ARRAY['PAID'::scm.sales_invoice_status, 'CANCELLED'::scm.sales_invoice_status]) THEN false
            WHEN total_sen > paid_sen THEN true
            ELSE false
        END AS is_outstanding,
    company_id
   FROM scm.sales_invoices s;

CREATE VIEW scm.v_so_outstanding AS
 SELECT doc_no,
    so_date,
    debtor_code,
    debtor_name,
    status,
    local_total_sen,
    total_revenue_sen,
        CASE
            WHEN status = ANY (ARRAY['DELIVERED'::scm.mfg_so_status, 'INVOICED'::scm.mfg_so_status, 'CLOSED'::scm.mfg_so_status, 'CANCELLED'::scm.mfg_so_status]) THEN false
            ELSE true
        END AS is_outstanding,
    company_id
   FROM scm.mfg_sales_orders so;


-- ── recreate the mv_ar_aging materialized view + its unique index (dropped above) ──
CREATE MATERIALIZED VIEW scm.mv_ar_aging AS
 SELECT COALESCE(v_po_outstanding.company_id, 0::bigint) AS company_id,
    'po'::text AS module,
    count(*) AS cnt,
    COALESCE(sum(v_po_outstanding.total_sen), 0::bigint) AS total_sen,
    0::bigint AS total_outstanding_sen
   FROM scm.v_po_outstanding
  WHERE v_po_outstanding.is_outstanding
  GROUP BY (COALESCE(v_po_outstanding.company_id, 0::bigint))
UNION ALL
 SELECT COALESCE(v_grn_outstanding.company_id, 0::bigint) AS company_id,
    'grn'::text AS module,
    count(*) AS cnt,
    0::bigint AS total_sen,
    0::bigint AS total_outstanding_sen
   FROM scm.v_grn_outstanding
  WHERE v_grn_outstanding.is_outstanding
  GROUP BY (COALESCE(v_grn_outstanding.company_id, 0::bigint))
UNION ALL
 SELECT COALESCE(v_pi_outstanding.company_id, 0::bigint) AS company_id,
    'pi'::text AS module,
    count(*) AS cnt,
    COALESCE(sum(v_pi_outstanding.total_sen), 0::bigint) AS total_sen,
    COALESCE(sum(v_pi_outstanding.outstanding_sen), 0::bigint) AS total_outstanding_sen
   FROM scm.v_pi_outstanding
  WHERE v_pi_outstanding.is_outstanding
  GROUP BY (COALESCE(v_pi_outstanding.company_id, 0::bigint))
UNION ALL
 SELECT COALESCE(v_pr_outstanding.company_id, 0::bigint) AS company_id,
    'pr'::text AS module,
    count(*) AS cnt,
    0::bigint AS total_sen,
    0::bigint AS total_outstanding_sen
   FROM scm.v_pr_outstanding
  WHERE v_pr_outstanding.is_outstanding
  GROUP BY (COALESCE(v_pr_outstanding.company_id, 0::bigint))
UNION ALL
 SELECT COALESCE(v_so_outstanding.company_id, 0::bigint) AS company_id,
    'so'::text AS module,
    count(*) AS cnt,
    COALESCE(sum(v_so_outstanding.local_total_sen), 0::bigint) AS total_sen,
    0::bigint AS total_outstanding_sen
   FROM scm.v_so_outstanding
  WHERE v_so_outstanding.is_outstanding
  GROUP BY (COALESCE(v_so_outstanding.company_id, 0::bigint))
UNION ALL
 SELECT COALESCE(v_do_outstanding.company_id, 0::bigint) AS company_id,
    'do'::text AS module,
    count(*) AS cnt,
    0::bigint AS total_sen,
    0::bigint AS total_outstanding_sen
   FROM scm.v_do_outstanding
  WHERE v_do_outstanding.is_outstanding
  GROUP BY (COALESCE(v_do_outstanding.company_id, 0::bigint))
UNION ALL
 SELECT COALESCE(v_si_outstanding.company_id, 0::bigint) AS company_id,
    'si'::text AS module,
    count(*) AS cnt,
    COALESCE(sum(v_si_outstanding.total_sen), 0::bigint) AS total_sen,
    COALESCE(sum(v_si_outstanding.outstanding_sen), 0::bigint) AS total_outstanding_sen
   FROM scm.v_si_outstanding
  WHERE v_si_outstanding.is_outstanding AND v_si_outstanding.status <> 'DRAFT'::scm.sales_invoice_status
  GROUP BY (COALESCE(v_si_outstanding.company_id, 0::bigint));
CREATE UNIQUE INDEX mv_ar_aging_company_module_uidx ON scm.mv_ar_aging USING btree (company_id, module);

-- ── recreate the 2 functions whose bodies reference the renamed columns ──
-- Neither has a trigger binding (verified 2026-08-18); both are called by RPC/SELECT.
DROP FUNCTION IF EXISTS scm.rebuild_mfg_so_delivery_lines(p_doc_no text, p_source_doc_no text, p_delivery_fee_sen bigint, p_rows jsonb);
CREATE FUNCTION scm.rebuild_mfg_so_delivery_lines(p_doc_no text, p_source_doc_no text, p_delivery_fee_sen bigint, p_rows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_company_id bigint;
BEGIN
  -- Serialize concurrent rebuilds of the SAME SO. hashtextextended gives a
  -- bigint key; the xact lock releases automatically at commit/rollback.
  PERFORM pg_advisory_xact_lock(hashtextextended('scm-so-delivery:' || p_doc_no, 0));

  SELECT company_id INTO v_company_id
    FROM scm.mfg_sales_orders
   WHERE doc_no = p_doc_no;
  -- Unknown SO: rebuild nothing rather than orphan lines onto a missing header.
  IF v_company_id IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM scm.mfg_sales_order_items
   WHERE doc_no = p_doc_no
     AND item_code IN ('SVC-DELIVERY', 'SVC-DELIVERY-CROSS', 'SVC-DELIVERY-ADD');

  INSERT INTO scm.mfg_sales_order_items (
    company_id, doc_no, line_no, line_date, debtor_name, item_group, item_code,
    description, description2, remark, uom, qty,
    unit_price_sen, discount_sen, total_sen, total_inc_sen, balance_sen,
    variants, unit_cost_sen, line_cost_sen, line_margin_sen,
    divan_price_sen, leg_price_sen, special_order_price_sen, custom_specials,
    line_delivery_date, line_delivery_date_overridden, warehouse_id,
    branding, venue, stock_status
  )
  SELECT v_company_id, r.doc_no, r.line_no, r.line_date, r.debtor_name, r.item_group, r.item_code,
         r.description, r.description2, r.remark, r.uom, r.qty,
         r.unit_price_sen, r.discount_sen, r.total_sen, r.total_inc_sen, r.balance_sen,
         r.variants, r.unit_cost_sen, r.line_cost_sen, r.line_margin_sen,
         r.divan_price_sen, r.leg_price_sen, r.special_order_price_sen, r.custom_specials,
         r.line_delivery_date, r.line_delivery_date_overridden, r.warehouse_id,
         r.branding, r.venue, r.stock_status
    FROM jsonb_populate_recordset(NULL::scm.mfg_sales_order_items, COALESCE(p_rows, '[]'::jsonb)) r;

  UPDATE scm.mfg_sales_orders
     SET cross_category_source_doc_no = p_source_doc_no,
         delivery_fee_sen           = p_delivery_fee_sen,
         updated_at                   = now()
   WHERE doc_no = p_doc_no;
END;
$function$;

DROP FUNCTION IF EXISTS scm.settle_pi_paid_centi(p_pi_id uuid, p_delta bigint);
CREATE FUNCTION scm.settle_pi_paid_sen(p_pi_id uuid, p_delta bigint)
 RETURNS TABLE(applied_sen bigint, new_paid_sen bigint, new_status text, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'scm', 'pg_temp'
AS $function$
DECLARE
  v_old_paid   bigint;
  v_total      bigint;
  v_status     text;
  v_new_paid   bigint;
  v_new_status text;
BEGIN
  IF p_pi_id IS NULL OR p_delta IS NULL OR p_delta = 0 THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'no_delta'::text; RETURN;
  END IF;

  -- The lock that makes this safe. A second settle against this PI waits here
  -- and then reads the row THIS transaction committed, not the one it started
  -- with, so its clamp is computed against the true remaining balance.
  SELECT COALESCE(paid_sen, 0), COALESCE(total_sen, 0), status::text
    INTO v_old_paid, v_total, v_status
    FROM purchase_invoices
   WHERE id = p_pi_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text, 'not_found'::text; RETURN;
  END IF;

  -- A DRAFT or CANCELLED invoice is not a live liability — unchanged behaviour.
  IF upper(COALESCE(v_status, '')) IN ('DRAFT', 'CANCELLED') THEN
    RETURN QUERY SELECT 0::bigint, v_old_paid, v_status, 'not_live'::text; RETURN;
  END IF;

  IF p_delta > 0 THEN
    -- LEAST caps the over-payment. The outer GREATEST stops a PI that is
    -- ALREADY over total (legacy data) from being silently pulled DOWN to
    -- total by an unrelated settle — this function only ever moves paid_sen
    -- in the direction of the delta it was given.
    v_new_paid := GREATEST(v_old_paid, LEAST(v_total, v_old_paid + p_delta));
  ELSE
    v_new_paid := GREATEST(0, v_old_paid + p_delta);
  END IF;

  UPDATE purchase_invoices
     SET paid_sen = v_new_paid,
         status     = CASE
                        WHEN v_new_paid >= v_total THEN 'PAID'
                        WHEN v_new_paid > 0        THEN 'PARTIALLY_PAID'
                        ELSE                            'POSTED'
                      END,
         updated_at = now()
   WHERE id = p_pi_id
  RETURNING status::text INTO v_new_status;

  RETURN QUERY SELECT (v_new_paid - v_old_paid), v_new_paid, v_new_status, NULL::text;
END;
$function$;


COMMIT;
