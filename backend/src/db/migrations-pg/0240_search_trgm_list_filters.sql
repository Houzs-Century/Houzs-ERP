-- 0240_search_trgm_list_filters.sql — pg_trgm GIN for the columns the MODULE
-- LIST search boxes filter on, which 0239 did not cover.
--
-- WHY A SECOND FILE. 0239 closed the gap for global search (the Cmd+K palette).
-- This one closes it for the per-module list filters — the search box on the SO,
-- DO, SI, supplier and consignment lists. Those are used more often than Cmd+K,
-- and they run the same `ILIKE '%term%'` through PostgREST, so they carry the
-- same seq-scan cost. The two were found by the same audit: every
-- `.or(...ilike...)` column in backend/src/scm, diffed against every
-- `gin_trgm_ops` index in this directory. Before 0239 that audit reported 9 of
-- 54 searched columns indexed; after it, 25; this file takes the remainder that
-- is worth taking.
--
-- VIEWS. Three of the searched relations are views, which cannot carry an index:
--   * scm.suppliers_with_derived_category — a plain `SELECT s.* FROM suppliers s`
--     plus one scalar sub-select, so an ILIKE predicate on s.code / s.name /
--     s.contact_person is pushed down to the base table and DOES use these
--     indexes.
--   * scm.mfg_sales_orders_with_payment_totals — same shape over
--     scm.mfg_sales_orders; its searched columns are base columns.
--   * scm.v_inventory_product_totals — its `product_code` / `product_name` ARE
--     `mfg_products.code` / `.name`, which 0074 already indexed. Nothing to do,
--     and it is named here so the next audit does not re-flag it.
--
-- NOT INDEXED, deliberately: scm.fabric_colours (colour_id, label) — a lookup
-- table of a few dozen rows where a seq scan is the cheaper plan, same reasoning
-- as roles.name in 0239.
--
-- Column existence was confirmed from the field maps in the routes that read and
-- write these tables daily (delivery-orders-mfg.ts, sales-invoices.ts,
-- suppliers.ts, the three consignment routers) — not from a migration file, per
-- the system-foundation-coe lesson.
--
-- Idempotent; NOT CONCURRENTLY (the runner wraps each file in a transaction).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- scm.suppliers — the supplier list search box (code / name / contact person),
-- reached through suppliers_with_derived_category.
CREATE INDEX IF NOT EXISTS trgm_scm_supp_code    ON scm.suppliers USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_supp_name    ON scm.suppliers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_supp_contact ON scm.suppliers USING gin (contact_person gin_trgm_ops);

-- scm.mfg_sales_orders — the SO list search box. doc_no / debtor_name / ref /
-- phone / po_doc_no came in 0074 and 0108; these four are the remainder.
CREATE INDEX IF NOT EXISTS trgm_mfg_so_debtor_code   ON scm.mfg_sales_orders USING gin (debtor_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_so_agent         ON scm.mfg_sales_orders USING gin (agent gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_so_sales_loc     ON scm.mfg_sales_orders USING gin (sales_location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_mfg_so_branding      ON scm.mfg_sales_orders USING gin (branding gin_trgm_ops);

-- scm.delivery_orders — the DO list search box. 0239 covered do_number /
-- so_doc_no / debtor_name / ref for the palette; the list also filters these.
CREATE INDEX IF NOT EXISTS trgm_scm_do_debtor_code ON scm.delivery_orders USING gin (debtor_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_do_branding    ON scm.delivery_orders USING gin (branding gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_do_sales_loc   ON scm.delivery_orders USING gin (sales_location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_do_driver_name ON scm.delivery_orders USING gin (driver_name gin_trgm_ops);

-- scm.sales_invoices — the SI list search box, same three extras as the DO list.
CREATE INDEX IF NOT EXISTS trgm_scm_si_debtor_code ON scm.sales_invoices USING gin (debtor_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_si_branding    ON scm.sales_invoices USING gin (branding gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_si_sales_loc   ON scm.sales_invoices USING gin (sales_location gin_trgm_ops);

-- The consignment trio — never indexed at all. Same document shapes as their
-- non-consignment siblings, same list search boxes.
CREATE INDEX IF NOT EXISTS trgm_scm_cdo_number      ON scm.consignment_delivery_orders USING gin (do_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cdo_debtor_name ON scm.consignment_delivery_orders USING gin (debtor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cdr_number      ON scm.consignment_delivery_returns USING gin (return_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cdr_debtor_name ON scm.consignment_delivery_returns USING gin (debtor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cso_doc_no      ON scm.consignment_sales_orders USING gin (doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cso_debtor_name ON scm.consignment_sales_orders USING gin (debtor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_cso_debtor_code ON scm.consignment_sales_orders USING gin (debtor_code gin_trgm_ops);
