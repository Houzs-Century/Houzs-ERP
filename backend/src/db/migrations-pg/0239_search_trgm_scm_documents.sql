-- 0239_search_trgm_scm_documents.sql — pg_trgm GIN indexes for the five
-- procurement/fulfilment document sources in global search.
--
-- WHY THIS EXISTS. The global search route (src/routes/search.ts) probes text
-- columns with ILIKE '%term%'. Without a trigram GIN index each probe is a
-- sequential scan. That pattern was established in 0001 (public schema) and
-- 0074 (scm.mfg_sales_orders + scm.mfg_products), extended by 0104
-- (products description/barcode, fabric) and 0108 (SO debtor_name/phone).
--
-- Then PR #1269 (2026-07-25) added FIVE more sources to the same route —
-- Purchase Order, GRN, Delivery Order, Sales Invoice, Purchase Invoice — and
-- did NOT add indexes for them. So every Cmd+K keystroke currently runs five
-- unindexed substring scans in parallel, on top of the six indexed ones. It is
-- invisible at today's row counts and gets linearly worse as documents
-- accumulate; this file closes that gap before the volume arrives.
--
-- COLUMN LIST. Exactly the columns the route filters on, no more — verified
-- against the `.or(...)` filters in routes/search.ts::appendScmHits. Note the
-- route SELECTs supplier(name) and purchase_order(po_number) as embedded FK
-- resources for display but does NOT filter on them (PostgREST cannot filter an
-- embed in `.or`), so those columns are deliberately not indexed here.
--
-- COLUMN EXISTENCE was confirmed from the routes that read and write these
-- tables every day (grns.ts, mfg-purchase-orders.ts, purchase-invoices.ts,
-- delivery-orders-mfg.ts field maps) — not from a migration file, per the
-- system-foundation-coe lesson about trusting migrations over the live schema.
--
-- Idempotent (IF NOT EXISTS), so a re-run is a no-op. NOT CONCURRENTLY: the
-- migration runner wraps each file in a transaction and CREATE INDEX
-- CONCURRENTLY cannot run inside one — same reasoning as 0074. Index builds on
-- these tables are brief at current volume, which is itself a reason to land
-- this now rather than after the tables grow.
--
-- roles.name is also searched (the user source joins it) and is deliberately
-- NOT indexed: it is a lookup table of a few dozen rows where a sequential scan
-- is the cheaper plan. Indexing it would cost writes and buy nothing.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- scm.purchase_orders — PO source. po_number is the doc number the operator
-- types; notes carries the free text the PO list also searches.
CREATE INDEX IF NOT EXISTS trgm_scm_po_number ON scm.purchase_orders USING gin (po_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_po_notes  ON scm.purchase_orders USING gin (notes gin_trgm_ops);

-- scm.grns — Goods Received Note source. delivery_note_ref is the supplier's
-- own DN number, which is how warehouse staff look a receipt up.
CREATE INDEX IF NOT EXISTS trgm_scm_grn_number    ON scm.grns USING gin (grn_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_grn_dn_ref    ON scm.grns USING gin (delivery_note_ref gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_grn_notes     ON scm.grns USING gin (notes gin_trgm_ops);

-- scm.delivery_orders — DO source. so_doc_no lets a DO be found by the SO it
-- came from, which is the lookup drivers and coordinators actually perform.
CREATE INDEX IF NOT EXISTS trgm_scm_do_number      ON scm.delivery_orders USING gin (do_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_do_so_doc_no   ON scm.delivery_orders USING gin (so_doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_do_debtor_name ON scm.delivery_orders USING gin (debtor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_do_ref         ON scm.delivery_orders USING gin (ref gin_trgm_ops);

-- scm.sales_invoices — SI source. Same shape as the DO: number, source SO,
-- customer, ref.
CREATE INDEX IF NOT EXISTS trgm_scm_si_number      ON scm.sales_invoices USING gin (invoice_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_si_so_doc_no   ON scm.sales_invoices USING gin (so_doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_si_debtor_name ON scm.sales_invoices USING gin (debtor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_si_ref         ON scm.sales_invoices USING gin (ref gin_trgm_ops);

-- scm.purchase_invoices — PI source. supplier_invoice_ref is the supplier's own
-- invoice number, the one printed on the paper being matched.
CREATE INDEX IF NOT EXISTS trgm_scm_pi_number       ON scm.purchase_invoices USING gin (invoice_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_pi_supplier_ref ON scm.purchase_invoices USING gin (supplier_invoice_ref gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_scm_pi_notes        ON scm.purchase_invoices USING gin (notes gin_trgm_ops);
