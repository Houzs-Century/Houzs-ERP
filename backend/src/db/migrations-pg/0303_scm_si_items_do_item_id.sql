-- Declare scm.sales_invoice_items.do_item_id — the column a MONEY CEILING rests
-- on and that no migration in this repository has ever created.
--
-- THE GAP, as found. `grep -rn --include='*.sql' do_item_id
-- backend/src/db/migrations-pg/` returns rc=1 and ZERO hits, and
-- backend/scripts/scm-schema/2990s-full-schema.sql gives sales_invoice_items a
-- so_item_id and no do_item_id. Yet the code both READS and WRITES it:
-- lib/do-line-remaining.ts sums `sales_invoice_items.qty` linked by do_item_id
-- to derive `invoiced`, which is the `invoiced` term in
--     remaining = delivered − invoiced − returned
-- — the cap every DO → Sales Invoice write path is checked against. A column
-- nothing declares is one rebuild away from taking that cap with it.
--
-- WHAT PRODUCTION ACTUALLY HAS, read from the live catalog rather than inferred:
-- a `pg_dump --schema-only --schema=scm` of prod (Actions → "Dump scm schema
-- snapshot (read-only)", target=prod) reports
--     do_item_id uuid                       -- nullable, no default
--     CONSTRAINT sales_invoice_items_do_item_id_fkey
--       FOREIGN KEY (do_item_id) REFERENCES scm.delivery_order_items(id)
--       ON DELETE SET NULL
-- and NO index on the column. This file declares exactly that and nothing more.
-- Nullable is correct and is not an oversight: the owner's rule is that a Sales
-- Invoice MAY carry a direct/standalone line (see lib/unlinked-line-edit-guard,
-- doPendingItemCodesOf), so a line with no source delivery is legitimate.
-- ON DELETE SET NULL is likewise load-bearing — deleting a DO line orphans its
-- invoice lines instead of deleting revenue, which the unlinked-line guard is
-- written around.
--
-- IT IS A NO-OP AGAINST PRODUCTION. ADD COLUMN IF NOT EXISTS does nothing when
-- the column is there, and the constraint is added only when pg_constraint does
-- not already carry that exact name (Postgres has no ADD CONSTRAINT IF NOT
-- EXISTS; migration 0083 guards its own DDL the same way). Nothing here drops,
-- renames or re-types anything: the column holds live links that a money cap is
-- derived from, and a re-type would rewrite the table.
--
-- WHY THE SCHEMA DUMP IS NOT EDITED TO MATCH. 2990s-full-schema.sql is a faithful
-- one-time export of the 2990's OWN schema (scripts/scm-schema/README.md) — the
-- CREATE side that apply-scm-schema.mjs replays. It is not stale, it is a
-- different system's table, and every Houzs-side addition to it lives in this
-- migration tree instead: company_id in 0083, linked_ac_dtlkey in 0280. This
-- column now joins them, which is the same answer those two already gave.
--
-- SIBLINGS LEFT ALONE, deliberately and on the record: the same prod dump shows
-- unit_cost_centi, line_cost_centi and line_margin_centi on this table are ALSO
-- absent from both SQL trees. They are the same class of gap but not this
-- defect, and folding them in would put unreviewed DDL inside a money fix.
-- Reported rather than smuggled.
--
-- REVERSAL: ALTER TABLE scm.sales_invoice_items DROP CONSTRAINT IF EXISTS
-- sales_invoice_items_do_item_id_fkey; then, ONLY on a database that never held
-- the column (a fresh rebuild), ALTER TABLE scm.sales_invoice_items DROP COLUMN
-- IF EXISTS do_item_id. Against production the reverse is a NO-OP by intent:
-- this migration created nothing there, and dropping the column would delete the
-- delivery links that `invoiced` is summed from — every already-invoiced line
-- would read as un-invoiced and the DO → SI cap would become the full delivered
-- quantity. Reverting the commit is always safe; running the DROP is not.

ALTER TABLE scm.sales_invoice_items ADD COLUMN IF NOT EXISTS do_item_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'scm'
      AND t.relname = 'sales_invoice_items'
      AND c.conname = 'sales_invoice_items_do_item_id_fkey'
  ) THEN
    ALTER TABLE scm.sales_invoice_items
      ADD CONSTRAINT sales_invoice_items_do_item_id_fkey
      FOREIGN KEY (do_item_id) REFERENCES scm.delivery_order_items(id) ON DELETE SET NULL;
  END IF;
END $$;
