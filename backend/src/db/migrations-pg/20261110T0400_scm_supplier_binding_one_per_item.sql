-- One binding per supplier per item, per company. MRP lists every binding row,
-- so a second row for the same (company, supplier, kind, item) showed that
-- supplier twice. The create / PATCH routes refuse a duplicate since #5486; this
-- makes the database refuse it too, whatever path writes.
--
-- Safe only because production has none: supplier-binding-duplicates-check.yml
-- reported 0 duplicate groups (4059 bindings) after
-- repair-supplier-binding-duplicates.mjs removed the one pair, 2026-11-09, runs
-- 42655781660 (apply) and 42656062181 (check). If a duplicate slipped in since,
-- this fails the deploy loudly rather than picking a row.
--
-- Not CONCURRENTLY: pg-migrate runs each file inside a transaction.
--
-- REVERSAL: DROP INDEX IF EXISTS scm.supplier_material_bindings_one_per_item_uq;
--   GRANTS: none — an index on an existing table rides its grants.

CREATE UNIQUE INDEX IF NOT EXISTS supplier_material_bindings_one_per_item_uq
  ON scm.supplier_material_bindings (company_id, supplier_id, material_kind, item_code);
