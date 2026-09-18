-- ----------------------------------------------------------------------------
-- 20260912T1000 — LINE-LEVEL PO outstanding view for the supplier chasing list.
--
-- Owner 2026-09-12: the existing Outstanding -> PO report (scm.v_po_outstanding,
-- mig 0084) is HEADER-level — one row per PO with qty_ordered/received/
-- outstanding + money — which is an AP "how much is owed" view. Procurement
-- needs the AutoCount "PO chasing list" shape instead: ONE ROW PER PO LINE that
-- still has un-received quantity, carrying the item, its spec, the ship-to
-- warehouse and the promised delivery date, so a buyer can chase each supplier.
-- This view is that line-level sibling; the header view is untouched.
--
-- Definition of outstanding here MIRRORS the header view exactly, applied per
-- line instead of per PO: RECEIVED/CANCELLED POs are never outstanding, and a
-- live line is outstanding when (qty - received_qty) > 0. remaining_qty is that
-- difference, i.e. the AutoCount "Remaining Qty".
--
-- The route (backend/src/scm/routes/outstanding.ts, GET /outstanding/po-lines)
-- filters is_outstanding + company + po_date range exactly like the other
-- /outstanding/<module> endpoints, so this view exposes ALL lines with the flag
-- rather than pre-filtering — same contract as its six siblings.
--
-- Column notes (each maps to an AutoCount export column):
--   po_number / ac_po_no      Doc No — ERP number + AutoCount linked_ac_docno
--   so_doc_no                 SO Doc No. — via so_item_id (NULL for stock POs)
--   creditor_code / _name     Creditor — supplier code + name
--   item_code / item_desc     Item Code / Item Description
--   item_desc2                Item Description 2 (colour / config free text)
--   location_code / _name     Location — ship-to warehouse (line-level)
--   item_group                Item Group (SOFA / MATTRESS / ACC / BEDFRAME ...)
--   po_date                   Doc Date
--   remaining_qty             Remaining Qty (qty - received_qty)
--   delivery_date             Delivery Date
--   supplier_delivery_date_2/3  the AutoCount UDF dates (sparse today)
-- Sofa sets are stored as component lines (no set key on the line — binding_id
-- is null and each component carries its own so_item_id); the roll-up-to-set
-- view is a PRESENTATION concern done client-side, not here.
--
-- GRANT: a view is a fresh object with an EMPTY ACL (backend/docs/
-- scm-view-trap-coe.md), and the API reads every scm view as service_role, so
-- the GRANT below is load-bearing — without it every /outstanding/po-lines call
-- 500s. Mirrors scm.v_po_outstanding's grantees.
--
-- PostgREST caches the schema; a brand-new relation it has not seen is invisible
-- to supabase-js until it reloads, so NOTIFY at the end (same as 0214/0286/0314/
-- 0316/0330). If the endpoint still 404/500s "not in schema cache" after deploy,
-- run the "Reload PostgREST schema" workflow.
--
-- REVERSAL: ship a NEW migration `DROP VIEW IF EXISTS scm.v_po_outstanding_lines;`
-- then NOTIFY pgrst. The view holds no data; reversing costs only the report.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

CREATE OR REPLACE VIEW scm.v_po_outstanding_lines AS
SELECT
  poi.id                                          AS po_item_id,
  po.id                                           AS po_id,
  po.po_number,
  po.linked_ac_docno                              AS ac_po_no,
  po.po_date,
  po.status,
  po.supplier_id,
  s.code                                          AS creditor_code,
  s.name                                          AS creditor_name,
  soi.doc_no                                      AS so_doc_no,
  poi.item_code,
  poi.material_name                               AS item_desc,
  poi.description2                                AS item_desc2,
  poi.item_group,
  poi.warehouse_id,
  w.code                                          AS location_code,
  w.name                                          AS location_name,
  poi.qty,
  poi.received_qty,
  (poi.qty - COALESCE(poi.received_qty, 0))       AS remaining_qty,
  poi.delivery_date,
  poi.supplier_delivery_date_2,
  poi.supplier_delivery_date_3,
  poi.line_no,
  poi.so_item_id,
  CASE
    WHEN po.status IN ('RECEIVED', 'CANCELLED') THEN FALSE
    WHEN (poi.qty - COALESCE(poi.received_qty, 0)) > 0 THEN TRUE
    ELSE FALSE
  END                                             AS is_outstanding,
  po.company_id
FROM scm.purchase_orders po
JOIN scm.purchase_order_items poi ON poi.purchase_order_id = po.id
LEFT JOIN scm.suppliers s            ON s.id   = po.supplier_id
LEFT JOIN scm.warehouses w           ON w.id   = poi.warehouse_id
LEFT JOIN scm.mfg_sales_order_items soi ON soi.id = poi.so_item_id;

GRANT SELECT ON scm.v_po_outstanding_lines TO service_role;

NOTIFY pgrst, 'reload schema';
