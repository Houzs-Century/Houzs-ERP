-- ----------------------------------------------------------------------------
-- 20260911T1500 — a Sales Order can be OPEN TO ALL (owner 2026-09-11).
--
-- Owner: "把这些 sales order open to all" for the AutoCount-imported historical
-- batch (the go-live import, doc_no `HC-SO-<6 digits>`). Those orders' original
-- salesperson attribution is no longer meaningful, and every staff member needs
-- to be able to look them up. Row-level SO visibility is otherwise
-- `access_staff_ids && caller-scope` (20260909T1000 + scm/lib/salesScope.ts):
-- a scoped rep sees only their own + downline + shared orders. There is no
-- per-order "everyone" grant, and overloading collaborator_staff_ids with every
-- staff uuid would be wrong (it breaks on the next hire and pollutes the
-- Handover panel). Hence a dedicated boolean.
--
-- `open_to_all` is VISIBILITY ONLY, exactly like access_staff_ids: it opens who
-- may SEE and (subject to the unchanged state locks — downstream DO/SI,
-- processing-lock, PO-lock, 2990 mirror) EDIT the order. It does NOT touch
-- attribution: salesperson_id / agent / commission are untouched, and nothing
-- here reaches AutoCount (the column has no counterpart on the AutoCount side).
-- The per-person money endpoints (/mine, /my-mtd) scope on the caller's own
-- staff uuid, not applySoScope, so an open order never inflates anyone's figures.
--
-- WHY A COLUMN AND NOT A ROW-SET IN CODE. Every scoped SO read is a LIST filtered
-- by the caller's scope, and the filter lives in ONE helper (applySoScope). A
-- boolean on the header lets that helper express "in my scope OR open to all" as
-- a single PostgREST `or=(access_staff_ids.ov.{…},open_to_all.is.true)` — one
-- array literal plus one scalar, not the two-array nesting 20260909T1000
-- deliberately avoided. No index: the table is ~3k rows and, once the batch is
-- backfilled, the flag is true on the MAJORITY of rows (low selectivity), so an
-- index would never be chosen and would only cost writes.
--
-- The BACKFILL that marks the ~2882 historical orders is NOT here — it is a
-- one-shot script + workflow_dispatch (backend/scripts/backfill-so-open-to-all.mjs
-- + .github/workflows/backfill-so-open-to-all.yml), because it targets real
-- production rows by a data-dependent predicate and a numbered migration would
-- re-run that UPDATE against every fresh/test database that has none of them.
-- This migration ships schema only; the flag defaults false, so nothing changes
-- until the backfill runs.
--
-- SECOND CONCERN — THE SCM VIEW TRAP (backend/docs/scm-view-trap-coe.md). The SO
-- LIST reads the VIEW scm.mfg_sales_orders_with_payment_totals, which ENUMERATES
-- its columns, and applySoScope filters `open_to_all` on that view too. A column
-- the view does not name does not exist to the list, and the scope filter moving
-- onto it would 500 the list for everyone. So the view is recreated here in the
-- SAME file. Unlike 20260909T1000/T1001 this is kept together: the ADD COLUMN is
-- IF NOT EXISTS and the view is CREATE OR REPLACE (append-only) — neither can
-- fail the way a DROP+CREATE can, and the column MUST exist before the view can
-- name it, so one ordered file is correct.
--
-- CREATE OR REPLACE VIEW, NOT DROP + CREATE — the whole safety argument. A
-- recreated view is a new object with an EMPTY ACL (this is how 0189 took the SO
-- list down and needed 0190 + 0191 to repair). CREATE OR REPLACE never drops the
-- object, so owner + every GRANT survive, and it may only APPEND columns at the
-- end — which is exactly what this does: the body below is 20260909T1001's
-- verbatim (the latest recreate on main), with `so.open_to_all` appended after
-- so.access_staff_ids. If a future edit must reorder/retype a column here,
-- CREATE OR REPLACE will refuse and the file must go to DROP + CREATE carrying a
-- grant-restore block — do not reach for DROP to silence the refusal.
--
-- REVERSAL: ship a NEW migration (this file is checksummed the moment it reaches
-- prod). Re-run 20260909T1001's CREATE VIEW body (this one without the last
-- column) so the view stops naming open_to_all, THEN
-- `ALTER TABLE scm.mfg_sales_orders DROP COLUMN open_to_all;`. No data lives in
-- the view; reversing costs only the feature.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- NOT NULL DEFAULT false is metadata-only on PG 11+ (constant default, no table
-- rewrite) and saves every read site from a null check.
ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS open_to_all boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN scm.mfg_sales_orders.open_to_all IS
  'VISIBILITY ONLY. true = every user may SEE and (subject to the state locks) EDIT this order, bypassing access_staff_ids scope. No attribution, no commission, nothing AutoCount reads. Set by backend/scripts/backfill-so-open-to-all.mjs for the imported historical batch. See docs/modules/sales-order.md.';

-- ── View trap: the SO list reads this view; teach it the new column ──────────
-- Body is 20260909T1001 verbatim + `so.open_to_all` appended after
-- so.access_staff_ids. Every existing column keeps its name, type and position.
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
    so.access_staff_ids,
    so.open_to_all
   FROM scm.mfg_sales_orders so
     LEFT JOIN ( SELECT mfg_sales_order_payments.so_doc_no,
            sum(mfg_sales_order_payments.amount_sen) AS paid_total
           FROM scm.mfg_sales_order_payments
          GROUP BY mfg_sales_order_payments.so_doc_no) p ON p.so_doc_no = so.doc_no;
