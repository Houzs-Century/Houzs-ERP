-- 0078_multicompany_views.sql — renumbered from the parked branch's 0062
-- (main independently used 0061..0076). Content is byte-identical: it recreates
-- the 10 scm views affected by 0077's company_id columns so they expose company_id.
-- Verified 2026-07-11: no migration or view-defining script on main has redefined
-- any of these 10 views since the branch was cut, so this is a faithful rebuild.
-- Apply IMMEDIATELY AFTER 0077 (migrate-before-deploy).

-- 0062_multicompany_views.sql — Phase 0b of the multi-company merge.
-- Design: docs/2026-07-多公司合并设计.md (locked). Companion to 0061 (which added
-- company_id to 118 base tables). Postgres FREEZES a view's output column set at
-- CREATE time, so the scm views built by apply-scm-views.mjs BEFORE 0061 do NOT
-- expose the new company_id column — even the ones written `SELECT so.*`. Any
-- route that scopes a view read by company_id (0b-core already does this on the
-- SO LIST, which reads mfg_sales_orders_with_payment_totals) then gets
-- `column company_id does not exist` → PostgREST 500. This migration recreates
-- every AFFECTED view so it carries company_id.
--
-- Splitter contract (scripts/pg-migrate.mjs): statements are split on ";\n".
-- Views have NO ";" except at the statement end, so each multi-line CREATE VIEW
-- is one statement. NO dollar-quoted ($$) bodies live here — the FIFO trigger
-- functions (which DO use $$, and which the ";\n" splitter would shred) are
-- fixed separately in scripts/scm-schema/inventory-fifo-trigger.sql. search_path
-- is pinned to scm below so the unqualified table refs inside each view body
-- resolve to scm (matching how apply-scm-views.mjs originally created them).
--
-- Idempotent + re-run-safe: DROP VIEW IF EXISTS + CREATE, and CREATE OR REPLACE.
-- Grants survive CREATE OR REPLACE; for the two DROP+CREATE views the scm schema's
-- ALTER DEFAULT PRIVILEGES (expose-scm-rest.mjs) re-grants service_role, and an
-- explicit GRANT is added for belt-and-suspenders. NOT applied here — owner
-- applies before deploy (migrate-before-deploy).

SET search_path TO scm, public;

-- 1) SO LIST view — `SELECT so.*` re-expands to pick up company_id (added to the
-- base table by 0061). CREATE OR REPLACE can't reorder columns, and so.* would
-- inject company_id BEFORE the computed cols, so DROP + CREATE (exactly as 2990
-- mig 0155 does). Body kept byte-for-byte from 0155 (drift-immune via so.*).
DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals;

CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
SELECT
  so.*,
  coalesce(p.paid_total, 0)                                     AS paid_total_centi,
  GREATEST(so.local_total_centi - coalesce(p.paid_total, 0), 0) AS balance_centi_live
FROM mfg_sales_orders so
LEFT JOIN (
  SELECT so_doc_no, sum(amount_centi)::bigint AS paid_total
  FROM mfg_sales_order_payments
  GROUP BY so_doc_no
) p ON p.so_doc_no = so.doc_no;

GRANT SELECT ON scm.mfg_sales_orders_with_payment_totals TO service_role;

-- 2) Outstanding views (2990 mig 0059) — single-base enumerations. company_id is
-- APPENDED as the last select item so CREATE OR REPLACE stays append-compatible
-- (existing columns keep their name/type/order). The base table's company_id is
-- functionally dependent on its PK, so it is valid to select even under GROUP BY.
CREATE OR REPLACE VIEW scm.v_po_outstanding AS
SELECT
  po.id, po.po_number, po.supplier_id, po.po_date, po.expected_at,
  po.currency, po.subtotal_centi, po.total_centi, po.status,
  COALESCE(SUM(poi.qty), 0)            AS qty_ordered,
  COALESCE(SUM(poi.received_qty), 0)   AS qty_received,
  COALESCE(SUM(poi.qty), 0) - COALESCE(SUM(poi.received_qty), 0) AS qty_outstanding,
  CASE
    WHEN po.status IN ('RECEIVED', 'CANCELLED') THEN FALSE
    WHEN COALESCE(SUM(poi.qty), 0) > COALESCE(SUM(poi.received_qty), 0) THEN TRUE
    ELSE FALSE
  END AS is_outstanding,
  po.company_id
FROM purchase_orders po
LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
GROUP BY po.id;

CREATE OR REPLACE VIEW scm.v_grn_outstanding AS
SELECT
  g.id, g.grn_number, g.supplier_id, g.received_at, g.status,
  g.created_at,
  CASE
    WHEN g.status = 'CANCELLED' THEN FALSE
    WHEN NOT EXISTS (SELECT 1 FROM purchase_invoices pi WHERE pi.grn_id = g.id) THEN TRUE
    ELSE FALSE
  END AS is_outstanding,
  g.company_id
FROM grns g;

CREATE OR REPLACE VIEW scm.v_pi_outstanding AS
SELECT
  pi.id, pi.invoice_number, pi.supplier_invoice_ref, pi.supplier_id,
  pi.invoice_date, pi.due_date, pi.total_centi, pi.paid_centi,
  (pi.total_centi - pi.paid_centi) AS outstanding_centi,
  pi.status,
  CASE
    WHEN pi.status IN ('PAID', 'CANCELLED') THEN FALSE
    WHEN pi.total_centi > pi.paid_centi THEN TRUE
    ELSE FALSE
  END AS is_outstanding,
  pi.company_id
FROM purchase_invoices pi;

CREATE OR REPLACE VIEW scm.v_pr_outstanding AS
SELECT
  pr.id, pr.return_number, pr.supplier_id, pr.return_date,
  pr.status, pr.refund_centi,
  CASE
    WHEN pr.status IN ('COMPLETED', 'CANCELLED') THEN FALSE
    ELSE TRUE
  END AS is_outstanding,
  pr.company_id
FROM purchase_returns pr;

CREATE OR REPLACE VIEW scm.v_so_outstanding AS
SELECT
  so.doc_no, so.so_date, so.debtor_code, so.debtor_name,
  so.status, so.local_total_centi, so.total_revenue_centi,
  CASE
    WHEN so.status IN ('DELIVERED', 'INVOICED', 'CLOSED', 'CANCELLED') THEN FALSE
    ELSE TRUE
  END AS is_outstanding,
  so.company_id
FROM mfg_sales_orders so;

CREATE OR REPLACE VIEW scm.v_do_outstanding AS
SELECT
  d.id, d.do_number, d.so_doc_no, d.debtor_code, d.debtor_name,
  d.do_date, d.status,
  CASE
    WHEN d.status IN ('INVOICED', 'CANCELLED') THEN FALSE
    ELSE TRUE
  END AS is_outstanding,
  d.company_id
FROM delivery_orders d;

CREATE OR REPLACE VIEW scm.v_si_outstanding AS
SELECT
  s.id, s.invoice_number, s.so_doc_no, s.delivery_order_id,
  s.debtor_code, s.debtor_name, s.invoice_date, s.due_date,
  s.total_centi, s.paid_centi,
  (s.total_centi - s.paid_centi) AS outstanding_centi,
  s.status,
  CASE
    WHEN s.status IN ('PAID', 'CANCELLED') THEN FALSE
    WHEN s.total_centi > s.paid_centi THEN TRUE
    ELSE FALSE
  END AS is_outstanding,
  s.company_id
FROM sales_invoices s;

-- 3) Suppliers list view (2990 mig 0088) — `SELECT s.*` + derived_category. Same
-- so.*-reorder problem as the SO view → DROP + CREATE. Drift-immune via s.*.
DROP VIEW IF EXISTS scm.suppliers_with_derived_category;

CREATE VIEW scm.suppliers_with_derived_category AS
SELECT
  s.*,
  (
    SELECT
      CASE
        WHEN count(DISTINCT mp.category) = 0 THEN NULL
        WHEN count(DISTINCT mp.category) = 1 THEN max(mp.category::text)
        ELSE 'MIXED'
      END
    FROM supplier_material_bindings smb
    LEFT JOIN mfg_products mp
      ON mp.code = smb.material_code
     AND smb.material_kind = 'mfg_product'
    WHERE smb.supplier_id = s.id
  ) AS derived_category
FROM suppliers s;

GRANT SELECT ON scm.suppliers_with_derived_category TO service_role;

-- 4) Inventory-balance view (2990 mig 0095) — the per-(warehouse, product,
-- variant) on-hand ledger rollup. company_id is added to BOTH the select (last)
-- and the GROUP BY so each company's stock stays its own bucket. Backfilled data
-- is all one company today, so this is row-for-row identical now and correct once
-- 2990 data lands. Dependents (v_inventory_all_skus / v_inventory_product_totals)
-- re-aggregate over product_code and ignore this column, so CREATE OR REPLACE
-- (append) leaves them intact.
CREATE OR REPLACE VIEW scm.inventory_balances AS
  SELECT
    warehouse_id,
    product_code,
    variant_key,
    MAX(product_name) AS product_name,
    SUM(
      CASE
        WHEN movement_type = 'IN'         THEN qty
        WHEN movement_type = 'OUT'        THEN -qty
        WHEN movement_type = 'ADJUSTMENT' THEN qty
        WHEN movement_type = 'TRANSFER'   THEN qty
        ELSE 0
      END
    ) AS qty,
    MAX(created_at) AS last_movement_at,
    company_id
  FROM inventory_movements
  GROUP BY warehouse_id, product_code, variant_key, company_id;
