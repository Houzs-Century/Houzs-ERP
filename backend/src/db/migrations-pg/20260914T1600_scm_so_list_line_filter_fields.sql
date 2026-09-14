-- 20260914T1600 — three computed fields the Sales Order list filters on.
--
-- WHY. The SO list's second-level filters (owner 2026-09-14) include three
-- questions about an order's LINES or AMENDMENTS — "has a line in warehouse X",
-- "has a sofa / bedframe / mattress / accessory line", "has a pending
-- amendment". The list reads the header view
-- scm.mfg_sales_orders_with_payment_totals through PostgREST, and the page, the
-- money totals and the status counts must all filter the same set server-side.
-- A list of matching doc numbers cannot ride the URL (a sofa filter matches
-- hundreds of orders; scm/lib/paginate-all.ts sizes URLs to 4KB). PostgREST
-- exposes a function whose single argument is a view's row type as a
-- FILTERABLE FIELD of that view ("computed field"), so each question becomes a
-- plain predicate on the same query the list already runs:
--   so_line_warehouse_ids=ov.{uuid}, so_line_categories=ov.{SOFA},
--   so_has_open_amendment=is.true
--
-- WHAT. Three STABLE SQL functions taking the view's row. Additive: nothing
-- reads them unless a filter names them; the view itself is NOT touched (the
-- view trap, backend/docs/scm-view-trap-coe.md).
--   · live lines only (cancelled = false), the same lines the list reads;
--   · a child row must carry the ORDER'S company_id as well as its doc number —
--     a parent-ownership key alone does not prove the row is in these books;
--   · categories fold item_group with the list handler's own normCategory rule
--     (BEDFRAME, SOFA, MATTRESS, ACCESSOR*, SERVICE, else OTHERS);
--   · "open amendment" is exactly the SO detail's has_open_amendment
--     (mfg-sales-orders.ts GET /:docNo): status NOT IN (SENT, REJECTED) AND
--     (lane IS NULL OR status = REQUESTED).
--
-- COST, measured on staging with THESE bodies (probe run 34819831872: created
-- in a transaction, EXPLAIN ANALYZE as service_role, rolled back; 2,943 Houzs
-- orders): one full read with the warehouse filter 94-97ms, item category
-- 157-167ms, pending amendment 42-46ms, all three together 231ms — against
-- 2-7ms for the same read unfiltered. A function per row is the cost (a SQL or
-- plpgsql body measured the same, run 34819665024); an inline EXISTS measured
-- 13-23ms (run 34818215402); it is not one predicate on the view, and the
-- embed that could carry it (a computed relationship) is untested here.
-- Any other filter the user has set (company, status tab, dates) narrows the
-- rows first. PostgREST acceptance of these fields on a view is checked against
-- a real PostgREST 14.5 by .github/workflows/postgrest-contract-so-list-filters.yml.
--
-- REVERSAL: ship a NEW migration that drops the three functions:
--   DROP FUNCTION IF EXISTS scm.so_line_warehouse_ids(scm.mfg_sales_orders_with_payment_totals);
--   DROP FUNCTION IF EXISTS scm.so_line_categories(scm.mfg_sales_orders_with_payment_totals);
--   DROP FUNCTION IF EXISTS scm.so_has_open_amendment(scm.mfg_sales_orders_with_payment_totals);
-- No data lives in them; the list's four filters stop working and every other
-- read is unaffected. NOTE for any future DROP VIEW of the payment-totals view:
-- these functions depend on its row type, so the drop needs CASCADE and this
-- file's bodies must be re-run after the recreate.
-- RE-RUN: no-op — CREATE OR REPLACE with identical bodies, GRANT is idempotent.

SET search_path = scm, public;

CREATE OR REPLACE FUNCTION scm.so_line_warehouse_ids(so scm.mfg_sales_orders_with_payment_totals)
RETURNS uuid[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT i.warehouse_id) FILTER (WHERE i.warehouse_id IS NOT NULL), '{}'::uuid[])
    FROM scm.mfg_sales_order_items i
   WHERE i.doc_no = so.doc_no
     AND i.company_id = so.company_id
     AND i.cancelled = false
$$;

CREATE OR REPLACE FUNCTION scm.so_line_categories(so scm.mfg_sales_orders_with_payment_totals)
RETURNS text[]
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT
           CASE
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%BEDFRAME%' THEN 'BEDFRAME'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%SOFA%'     THEN 'SOFA'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%MATTRESS%' THEN 'MATTRESS'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%ACCESSOR%' THEN 'ACCESSORY'
             WHEN upper(btrim(coalesce(i.item_group, ''))) LIKE '%SERVICE%'  THEN 'SERVICE'
             ELSE 'OTHERS'
           END), '{}'::text[])
    FROM scm.mfg_sales_order_items i
   WHERE i.doc_no = so.doc_no
     AND i.company_id = so.company_id
     AND i.cancelled = false
$$;

CREATE OR REPLACE FUNCTION scm.so_has_open_amendment(so scm.mfg_sales_orders_with_payment_totals)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM scm.so_amendments a
     WHERE a.so_doc_no = so.doc_no
       AND a.company_id = so.company_id
       AND a.status NOT IN ('SENT', 'REJECTED')
       AND (a.lane IS NULL OR a.status = 'REQUESTED')
  )
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION scm.so_line_warehouse_ids(scm.mfg_sales_orders_with_payment_totals) TO service_role;
    GRANT EXECUTE ON FUNCTION scm.so_line_categories(scm.mfg_sales_orders_with_payment_totals) TO service_role;
    GRANT EXECUTE ON FUNCTION scm.so_has_open_amendment(scm.mfg_sales_orders_with_payment_totals) TO service_role;
  END IF;
END $$;
