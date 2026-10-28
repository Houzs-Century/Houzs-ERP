-- 0111_scm_hot_indexes.sql — btree indexes on the SCM list + enrichment hot
-- columns.
--
-- Live measurement (2026-07-14): GET /api/scm/mfg-sales-orders takes ~319ms
-- server-side for only ~62 SOs. A code audit found the scm.* tables are almost
-- entirely UNINDEXED on their hot columns: every list does `ORDER BY <date>
-- DESC LIMIT 500` with no index on the date (full-table sort each load), and
-- every enrichment does `.in(<join_col>, ids)` with no index on the join column
-- (sequential scan). This adds a fixed per-request tax now and turns linear as
-- the tables grow — the 10x/100x scaling risk.
--
-- Every column indexed below is one the running handlers already filter / sort /
-- join on (confirmed against the live query code), so the columns are known to
-- exist. Mirrors 0104 / 0108: plain CREATE INDEX IF NOT EXISTS (NOT a DO block —
-- the pg-migrate runner splits each file on ";\n", which would fragment a
-- dollar-quoted block), non-concurrent (the runner wraps each file in a
-- transaction; CREATE INDEX CONCURRENTLY can't run inside one), idempotent
-- (IF NOT EXISTS) so the auto-apply re-run on every deploy is a no-op. The scm
-- tables are small today so a plain build takes a trivial lock.

-- ── Enrichment / lifecycle join columns (every list hits these with .in(...)) ──
CREATE INDEX IF NOT EXISTS idx_scm_mfg_so_items_doc_no ON scm.mfg_sales_order_items (doc_no);
CREATE INDEX IF NOT EXISTS idx_scm_do_items_so_item_id ON scm.delivery_order_items (so_item_id);
CREATE INDEX IF NOT EXISTS idx_scm_do_so_doc_no ON scm.delivery_orders (so_doc_no);
CREATE INDEX IF NOT EXISTS idx_scm_si_so_doc_no ON scm.sales_invoices (so_doc_no);
CREATE INDEX IF NOT EXISTS idx_scm_si_delivery_order_id ON scm.sales_invoices (delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_scm_dr_delivery_order_id ON scm.delivery_returns (delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_scm_grn_items_grn_id ON scm.grn_items (grn_id);
CREATE INDEX IF NOT EXISTS idx_scm_grns_supplier_id ON scm.grns (supplier_id);

-- ── Scoped-caller filter columns (.in('salesperson_id', scopeIds)) ──
CREATE INDEX IF NOT EXISTS idx_scm_mfg_so_salesperson_id ON scm.mfg_sales_orders (salesperson_id);
CREATE INDEX IF NOT EXISTS idx_scm_do_salesperson_id ON scm.delivery_orders (salesperson_id);
CREATE INDEX IF NOT EXISTS idx_scm_si_salesperson_id ON scm.sales_invoices (salesperson_id);

-- ── Composite (company_id, <date> DESC) to serve the scoped `ORDER BY <date>
-- DESC LIMIT 500` behind every list without a full-table sort ──
CREATE INDEX IF NOT EXISTS idx_scm_mfg_so_company_so_date ON scm.mfg_sales_orders (company_id, so_date DESC);
CREATE INDEX IF NOT EXISTS idx_scm_do_company_do_date ON scm.delivery_orders (company_id, do_date DESC);
CREATE INDEX IF NOT EXISTS idx_scm_si_company_invoice_date ON scm.sales_invoices (company_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_scm_grns_company_received_at ON scm.grns (company_id, received_at DESC);
