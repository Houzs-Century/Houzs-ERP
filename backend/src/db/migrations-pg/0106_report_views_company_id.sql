-- 0106_report_views_company_id.sql — cross-company LEAK FIX for SCM report views.
--
-- Migration 0084 (renumbered 0078) rebuilt only ~10 scm views to EXPOSE
-- company_id after 0083 added company_id to the 118 base tables. Eight
-- FINANCIAL / INVENTORY report views were MISSED, so they still freeze a
-- company_id-less output column set. The accounting + inventory report routes
-- therefore aggregate BOTH companies' books (company 1 = HOUZS, 2 = 2990).
--
-- This migration recreates those 8 views to APPEND company_id, propagated from
-- the per-company ledger / base table each view is anchored on. Business logic,
-- columns and their order are otherwise UNCHANGED — company_id is appended LAST
-- so CREATE OR REPLACE stays append-compatible (existing columns keep their
-- name / type / position). The companion route change adds an
-- `.eq('company_id', <active>)` on each read.
--
-- View bodies are byte-faithful to pg_get_viewdef('scm.<view>', true) dumped
-- from STAGING (2026-07-14, run 29301441002) — the DB is ground truth (these
-- views were created by a separate scm-schema restore, not by any migration in
-- this repo). Only the added `company_id` select item (and, for the two
-- GROUP BY views, the added GROUP BY key) differ from the dump.
--
-- Splitter contract (scripts/pg-migrate.mjs splits on /;\s*\n/): every statement
-- below is a single CREATE OR REPLACE VIEW whose only ";" is at the very end —
-- no dollar-quoted bodies, no internal ";\n". search_path is pinned to scm so
-- the (already fully-qualified) bodies and the appended alias.company_id refs
-- resolve in scm. Additive + idempotent (CREATE OR REPLACE).

SET search_path TO scm, public;

-- 1) v_gl_entries — general-ledger line stream. Anchor: the journal-entry HEADER
--    (journal_entries j) — the ledger owner. Append j.company_id. (lines l also
--    carry company_id and equal j's; the header is the canonical ledger anchor.)
CREATE OR REPLACE VIEW scm.v_gl_entries AS
 SELECT l.id AS line_id,
    j.je_no,
    j.entry_date,
    j.source_type,
    j.source_doc_no,
    l.line_no,
    l.account_code,
    a.account_name,
    a.account_type,
    l.debit_sen,
    l.credit_sen,
    l.party_type,
    l.party_code,
    l.party_name,
    l.notes,
    j.posted,
    j.posted_at,
    j.company_id
   FROM scm.journal_entry_lines l
     JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     JOIN scm.accounts a ON a.account_code = l.account_code
  WHERE j.posted = true AND j.reversed = false
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;

-- 2) v_account_balances — per-account debit/credit rollup. Anchor: the chart of
--    accounts (accounts a), which is per-company. Append a.company_id to BOTH the
--    SELECT and the GROUP BY so each company's account balances stay their own
--    bucket (row-for-row identical while data is single-company).
CREATE OR REPLACE VIEW scm.v_account_balances AS
 SELECT a.account_code,
    a.account_name,
    a.account_type,
    COALESCE(sum(l.debit_sen), 0::bigint) AS total_debit_sen,
    COALESCE(sum(l.credit_sen), 0::bigint) AS total_credit_sen,
        CASE
            WHEN a.account_type = ANY (ARRAY['ASSET'::text, 'EXPENSE'::text]) THEN COALESCE(sum(l.debit_sen), 0::bigint) - COALESCE(sum(l.credit_sen), 0::bigint)
            ELSE COALESCE(sum(l.credit_sen), 0::bigint) - COALESCE(sum(l.debit_sen), 0::bigint)
        END AS balance_sen,
    a.company_id
   FROM scm.accounts a
     LEFT JOIN scm.journal_entry_lines l ON l.account_code = a.account_code
     LEFT JOIN scm.journal_entries j ON j.id = l.journal_entry_id AND j.posted = true AND j.reversed = false
  GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
  ORDER BY a.account_code;

-- 3) v_ar_aging — receivables aging. Single base: sales_invoices s. Append
--    s.company_id.
CREATE OR REPLACE VIEW scm.v_ar_aging AS
 SELECT id AS invoice_id,
    invoice_number,
    debtor_code,
    debtor_name,
    invoice_date,
    due_date,
    total_centi,
    paid_centi,
    total_centi - paid_centi AS outstanding_centi,
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
    s.company_id
   FROM scm.sales_invoices s
  WHERE total_centi > paid_centi AND (status <> ALL (ARRAY['CANCELLED'::scm.sales_invoice_status, 'VOID'::scm.sales_invoice_status]));

-- 4) v_ap_aging — payables aging. Anchor: the invoice header purchase_invoices p
--    (suppliers sup is only a name lookup). Append p.company_id.
CREATE OR REPLACE VIEW scm.v_ap_aging AS
 SELECT p.id AS invoice_id,
    p.invoice_number,
    p.supplier_invoice_ref,
    p.supplier_id,
    sup.code AS supplier_code,
    sup.name AS supplier_name,
    p.invoice_date,
    p.due_date,
    p.total_centi,
    p.paid_centi,
    p.total_centi - p.paid_centi AS outstanding_centi,
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
  WHERE p.total_centi > p.paid_centi AND (p.status <> ALL (ARRAY['CANCELLED'::scm.purchase_invoice_status, 'VOID'::scm.purchase_invoice_status]));

-- 5) v_inventory_value — on-hand valuation from open FIFO lots. Anchor:
--    inventory_lots l (the per-company stock ledger). Append l.company_id to BOTH
--    the SELECT and the GROUP BY (mirrors how 0084 scoped inventory_balances).
CREATE OR REPLACE VIEW scm.v_inventory_value AS
 SELECT l.warehouse_id,
    w.code AS warehouse_code,
    l.product_code,
    l.variant_key,
    l.product_name,
    sum(l.qty_remaining) AS qty_on_hand,
    sum(l.qty_remaining * l.unit_cost_sen) AS value_sen,
        CASE
            WHEN sum(l.qty_remaining) > 0 THEN sum(l.qty_remaining * l.unit_cost_sen) / sum(l.qty_remaining)
            ELSE 0::bigint
        END AS avg_unit_cost_sen,
    l.company_id
   FROM scm.inventory_lots l
     LEFT JOIN scm.warehouses w ON w.id = l.warehouse_id
  WHERE l.qty_remaining > 0
  GROUP BY l.warehouse_id, w.code, l.product_code, l.variant_key, l.product_name, l.company_id;

-- 6) v_cogs_entries — cost-of-goods-sold consumption stream. Anchor: the
--    consumption fact table inventory_lot_consumptions c (the COGS ledger; it
--    carries company_id). Append c.company_id. (Note: the base is
--    inventory_lot_consumptions, NOT the unrelated cogs_entries table — which has
--    no company_id and is not read here.)
CREATE OR REPLACE VIEW scm.v_cogs_entries AS
 SELECT c.id,
    c.consumed_at,
    c.warehouse_id,
    w.code AS warehouse_code,
    c.product_code,
    c.variant_key,
    c.qty_consumed,
    c.unit_cost_sen,
    c.total_cost_sen,
    c.source_doc_type,
    c.source_doc_no,
    l.received_at AS lot_received_at,
    l.source_doc_no AS lot_source_doc_no,
    c.company_id
   FROM scm.inventory_lot_consumptions c
     JOIN scm.inventory_lots l ON l.id = c.lot_id
     LEFT JOIN scm.warehouses w ON w.id = c.warehouse_id
  ORDER BY c.consumed_at DESC;

-- 7) v_inventory_lots_open — open FIFO lots. Anchor: inventory_lots l. Append
--    l.company_id.
CREATE OR REPLACE VIEW scm.v_inventory_lots_open AS
 SELECT l.id,
    l.warehouse_id,
    w.code AS warehouse_code,
    l.product_code,
    l.variant_key,
    l.product_name,
    l.qty_received,
    l.qty_remaining,
    l.unit_cost_sen,
    l.qty_remaining * l.unit_cost_sen AS remaining_value_sen,
    l.received_at,
    l.source_doc_type,
    l.source_doc_no,
    l.batch_no,
    l.company_id
   FROM scm.inventory_lots l
     LEFT JOIN scm.warehouses w ON w.id = l.warehouse_id
  WHERE l.qty_remaining > 0
  ORDER BY l.received_at;

-- 8) v_inventory_product_totals — per-product catalogue rollup. Anchor: the
--    product master mfg_products p (per-company). Append p.company_id.
--    ⚠ REVIEW: the inner b (inventory_balances) and v (inventory_lots) subqueries
--    aggregate by product_code ONLY (no company_id in their GROUP BY / join).
--    Product codes are per-company today (master_codes, 0087), so a code maps to
--    one company's product row and totals stay correct; but if a product_code is
--    ever reused across companies these subqueries would sum both books. Scoping
--    the outer read by p.company_id fixes the exposed leak; tightening the
--    subqueries is a follow-up left for human review to avoid changing business
--    logic here.
CREATE OR REPLACE VIEW scm.v_inventory_product_totals AS
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
    ms.unit_price_centi AS main_supplier_price_centi,
    p.company_id
   FROM scm.mfg_products p
     LEFT JOIN ( SELECT inventory_balances.product_code,
            sum(inventory_balances.qty) AS qty,
            max(inventory_balances.last_movement_at) AS last_movement_at
           FROM scm.inventory_balances
          GROUP BY inventory_balances.product_code) b ON b.product_code = p.code
     LEFT JOIN ( SELECT inventory_lots.product_code,
            sum(inventory_lots.qty_remaining * inventory_lots.unit_cost_sen) AS value_sen
           FROM scm.inventory_lots
          WHERE inventory_lots.qty_remaining > 0
          GROUP BY inventory_lots.product_code) v ON v.product_code = p.code
     LEFT JOIN LATERAL ( SELECT sup.code AS supplier_code,
            sup.name AS supplier_name,
            smb.unit_price_centi
           FROM scm.supplier_material_bindings smb
             JOIN scm.suppliers sup ON sup.id = smb.supplier_id
          WHERE smb.material_code = p.code
          ORDER BY smb.is_main_supplier DESC, smb.unit_price_centi
         LIMIT 1) ms ON true
  WHERE p.status = 'ACTIVE'::scm.mfg_product_status;
