-- 0284 — Retire scm.consignment_sales_orders.proceeded_at (mig 0153).
--
-- WHY. The owner's standing instruction (2026-08-13, said more than three
-- times): "internal expected date, processing date and process date must be ONE
-- thing, not several — every processing-date bug comes from having too many."
-- The DATA was unified on 2026-08-13 (519 company-1 orders migrated out of
-- proceeded_at into scm.mfg_sales_orders.internal_expected_dd; both companies
-- now report zero split). What was left was the NAMES: the same concept still
-- answered to several column names across several tables, so the next reader
-- picked the wrong one — which is how it broke every previous time.
--
-- This file retires ONE of those names. scm.consignment_sales_orders got a
-- `proceeded_at` column in 0153 purely because the consignment module was
-- cloned from scm.mfg_sales_orders wholesale. On the CONSIGNMENT table it was
-- never wired to anything.
--
-- EVIDENCE (source, re-measured on this branch, not from docs):
--   • ZERO WRITERS. Every write to the table is in
--     backend/src/scm/routes/consignment-orders.ts and none names the column:
--       - the CO create INSERT (the header object) has no proceeded_at key;
--       - the header PATCH builds `updates` ONLY from the closed `map` of
--         [camelKey, snake_col] pairs — proceeded_at is not in that map, so no
--         request body can reach it (there is no passthrough / spread);
--       - the status PATCH writes exactly { status, updated_at };
--       - recomputeTotals writes only the money + line_count columns.
--     No script under backend/scripts/ writes it either (the two that touch
--     this table write `phone` / read branding).
--   • ZERO READERS. `grep -rn 'proceeded_at|proceededAt'` over the whole repo
--     returns 182 hits in 41 files and EVERY one of them resolves to
--     scm.mfg_sales_orders (routes/mfg-sales-orders.ts, lib/so-stock-allocation.ts
--     — which selects `.from('mfg_sales_orders')` — routes/delivery-planning.ts,
--     and the check-*/backfill-* scripts, all of which say
--     `FROM scm.mfg_sales_orders`). consignment-orders.ts does not contain the
--     string at all, and the CO HEADER select does not list it.
--
-- scm.mfg_sales_orders.proceeded_at is NOT touched here and must not be: it is
-- a live lifecycle TIMESTAMP the system stamps at Proceed (a different fact
-- from the date a user picks), and the stock allocator gates on it.
--
-- WHY THIS DROP IS SAFE TO SHIP IN THIS DEPLOY, while the sibling column
-- consignment_sales_orders.processing_date is NOT (that column's deferral, and
-- the exact SQL for its follow-up drop, are recorded at the HEADER select in
-- backend/src/scm/routes/consignment-orders.ts): deploy.yml
-- runs `node scripts/pg-migrate.mjs` BEFORE `wrangler deploy`, so for ~a minute
-- the OLD Worker is live against the NEW schema. A column the currently-live
-- code still SELECTs must therefore not be dropped in the same deploy that
-- stops selecting it — PostgREST errors on a select naming a missing column,
-- which is exactly how #1191/0189 blocked prod. proceeded_at has no such
-- exposure: no deployed version of the code reads it, so there is no window.

-- Pre-flight: 0189 shipped a bare DROP and was blocked in prod for hours
-- because a VIEW projected the column ("cannot drop column ... because other
-- objects depend on it"). No view in this repo's migration history references
-- scm.consignment_sales_orders, but migrations-as-state is not authoritative —
-- so name any real dependent instead of failing with a bare catalog error.
DO $$
DECLARE deps text;
BEGIN
  SELECT string_agg(DISTINCT dependent.relname, ', ')
    INTO deps
    FROM pg_depend d
    JOIN pg_rewrite r      ON r.oid = d.objid
    JOIN pg_class dependent ON dependent.oid = r.ev_class
    JOIN pg_class src      ON src.oid = d.refobjid
    JOIN pg_namespace n    ON n.oid = src.relnamespace
    JOIN pg_attribute a    ON a.attrelid = src.oid AND a.attnum = d.refobjsubid
   WHERE n.nspname = 'scm'
     AND src.relname = 'consignment_sales_orders'
     AND a.attname = 'proceeded_at'
     AND dependent.relname <> 'consignment_sales_orders';
  IF deps IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot drop scm.consignment_sales_orders.proceeded_at: these objects still project it: %. Drop/recreate them WITHOUT the column first (and re-GRANT them — 0189 dropped a view and lost its ACL, see BUG-HISTORY 0189 regrant).', deps;
  END IF;
END $$;

ALTER TABLE scm.consignment_sales_orders DROP COLUMN IF EXISTS proceeded_at;
