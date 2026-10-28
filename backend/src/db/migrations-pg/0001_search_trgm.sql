-- Search acceleration: pg_trgm GIN indexes on every column the global
-- search route (src/routes/search.ts) probes with ILIKE '%term%'.
-- Pattern proven on Hookka ERP (their migration 0150). Substring search
-- drops from a sequential scan to an index scan (~10-100ms at scale).
-- Postgres-only — the D1 test fallback never runs this file.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- sales_orders
CREATE INDEX IF NOT EXISTS trgm_so_doc_no       ON sales_orders USING gin (doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_so_debtor_name  ON sales_orders USING gin (debtor_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_so_ref          ON sales_orders USING gin (ref gin_trgm_ops);

-- purchase_orders (outstanding lines)
CREATE INDEX IF NOT EXISTS trgm_po_doc_no       ON purchase_orders USING gin (doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_po_item_code    ON purchase_orders USING gin (item_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_po_item_desc    ON purchase_orders USING gin (item_description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_po_creditor     ON purchase_orders USING gin (creditor_name gin_trgm_ops);

-- purchase_order_docs
CREATE INDEX IF NOT EXISTS trgm_pod_doc_no      ON purchase_order_docs USING gin (doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_pod_ref         ON purchase_order_docs USING gin (ref gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_pod_creditor    ON purchase_order_docs USING gin (creditor_name gin_trgm_ops);

-- projects
CREATE INDEX IF NOT EXISTS trgm_proj_code       ON projects USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proj_name       ON projects USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proj_venue      ON projects USING gin (venue gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proj_organizer  ON projects USING gin (organizer gin_trgm_ops);

-- assr_cases
CREATE INDEX IF NOT EXISTS trgm_assr_no         ON assr_cases USING gin (assr_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_assr_customer   ON assr_cases USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_assr_phone      ON assr_cases USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_assr_issue      ON assr_cases USING gin (complaint_issue gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_assr_doc_no     ON assr_cases USING gin (doc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_assr_po_no      ON assr_cases USING gin (po_no gin_trgm_ops);

-- creditors
CREATE INDEX IF NOT EXISTS trgm_cred_code       ON creditors USING gin (creditor_code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_cred_company    ON creditors USING gin (company_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_cred_desc2      ON creditors USING gin (desc2 gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_cred_email      ON creditors USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_cred_phone1     ON creditors USING gin (phone1 gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_cred_mobile     ON creditors USING gin (mobile gin_trgm_ops);

-- trips + users (small today, indexed for parity with the search route)
CREATE INDEX IF NOT EXISTS trgm_trips_no        ON trips USING gin (trip_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_trips_notes     ON trips USING gin (notes gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_users_name      ON users USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_users_email     ON users USING gin (email gin_trgm_ops);
