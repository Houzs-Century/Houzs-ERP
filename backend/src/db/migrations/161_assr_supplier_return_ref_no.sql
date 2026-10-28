-- D1 / test-tree twin of migrations-pg/20260924T2300_assr_supplier_return_ref_no.sql.
-- Column only: the prod backfill mints through scm.next_doc_no_n, which the
-- SQLite mirror does not have, and tests start empty.
ALTER TABLE assr_supplier_returns ADD COLUMN ref_no TEXT;
