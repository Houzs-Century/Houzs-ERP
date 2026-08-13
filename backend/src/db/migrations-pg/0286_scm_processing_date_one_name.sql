-- 0286 — ONE NAME for the Processing Date: rename
-- scm.mfg_sales_orders.internal_expected_dd -> processing_date, and the
-- consignment twin scm.consignment_sales_orders.internal_expected_dd
-- identically.
--
-- WHY. Owner, 2026-08-13, after saying it more than three times: "你确保你的
-- process（就是整套系统）里，把 internal expected date、processing date 和
-- process date 都直接整合变成一个，不要再搞多个了。因为每一次讨论到 processing
-- date 的时候，你就有各种各样的 bug，原因就是因为你有太多个了。这三个 date 其实
-- 都是指向同一个东西。"
--
-- The DATA was unified on 2026-08-13 (519 company-1 orders moved out of
-- proceeded_at into internal_expected_dd; both companies report zero split).
-- What was left is that the one concept still answered to three names, and the
-- column name was the last place still disagreeing with the humans, the UI
-- label ("Processing Date") and the API field. This migration settles it on the
-- name everybody already says.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE VIEW. scm.mfg_sales_orders_with_payment_totals PROJECTS this column, and
-- that projection is what made 0189 -> 0190 -> 0191 a three-migration incident:
-- 0189 needed DROP VIEW -> DROP COLUMN -> CREATE VIEW, and a recreated view is a
-- NEW object whose ACL and owner do not survive, so prod died with "permission
-- denied for view mfg_sales_orders_with_payment_totals" TWICE before 0191
-- copied the grant set back off a never-dropped sibling.
--
-- A RENAME IS NOT THAT PROBLEM, and this was verified rather than assumed
-- (PGlite 17, full base-table + view + grant replica, both roles):
--
--   * ALTER TABLE ... RENAME COLUMN on the base table SUCCEEDS while a view
--     projects it. Postgres stores the view's rewrite rule by attribute number,
--     so it re-points itself: pg_get_viewdef afterwards reads
--     "so.processing_date AS internal_expected_dd". Nothing is dropped, so the
--     view keeps its ACL and its owner and 0190/0191 do not repeat.
--   * But the view's OWN output column keeps the OLD name. Left alone, the view
--     is not broken — it is STALE, and every backend read of the view by the
--     new name would 500 with "column processing_date does not exist" while the
--     base table happily has it. That is the trap this migration exists to
--     close, and it is closed by ALTER VIEW ... RENAME COLUMN, which is a
--     catalog rename: grants (service_role AND the Hyperdrive prod role that
--     0191 had to go find) and owner were re-checked after it and are
--     unchanged.
--   * Indexes on the column follow the rename by themselves; the index NAME is
--     left as-is deliberately, because renaming indexes is churn with a lock
--     and no reader ever types an index name.
--
-- scm.apply_so_header_cas (mig 0173) needs NO change and this too was CONFIRMED,
-- not assumed: it builds its UPDATE SET list dynamically from pg_attribute over
-- scm.mfg_sales_orders, so it picks the new name up on its next call. Note for
-- the reader, because it bites silently: the function feeds the patch through
-- jsonb_populate_record(NULL::scm.mfg_sales_orders, $1), which IGNORES a JSON
-- key that is not a column. A caller still sending "internal_expected_dd" would
-- therefore not error — the date would just stop saving. The callers are
-- renamed in this same commit.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE CONSIGNMENT COLLISION. scm.consignment_sales_orders was cloned from the
-- SO header, so it carries BOTH names: the live internal_expected_dd AND a dead
-- legacy processing_date (mig 0153). 0189 dropped the mfg table's dead twin and
-- explicitly left this one alone. It has no writer anywhere in the API — the
-- Consignment Orders list even carries a comment saying its "Processing Date"
-- column must read internal_expected_dd "or it shows permanently blank" — so the
-- rename cannot land until it is gone. Verified in the same replica: the rename
-- fails with "column processing_date of relation consignment_sales_orders
-- already exists" until the dead column is dropped.
--
-- Idempotent throughout: every step is guarded on the catalog, so a re-run is a
-- no-op, and the post-condition block below RAISEs (rolling the whole file back,
-- the runner wraps each file in one transaction) rather than half-landing.

-- ── 1. The consignment twin's dead legacy column, out of the way ────────────
-- Guarded on table existence: 0083 shows scm.consignment_sales_orders is not
-- guaranteed to exist in every environment. No CASCADE — nothing may be dropped
-- silently along with it; if a dependent ever appears, this stops and says so.
--
-- THE GUARD IS THE WHOLE POINT, and the first draft got it wrong: a bare
-- `DROP COLUMN IF EXISTS processing_date` is idempotent-looking and is in fact
-- DESTRUCTIVE on re-run — after step 2 the surviving processing_date IS the
-- renamed live column, so a second pass would drop the users' dates. The replica
-- run caught it on the second apply. Drop only while BOTH names are present,
-- i.e. only while there is a genuine collision to clear.
DO $$
BEGIN
  IF to_regclass('scm.consignment_sales_orders') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'scm.consignment_sales_orders'::regclass
         AND attname = 'internal_expected_dd' AND attnum > 0 AND NOT attisdropped
     )
     AND EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'scm.consignment_sales_orders'::regclass
         AND attname = 'processing_date' AND attnum > 0 AND NOT attisdropped
     ) THEN
    ALTER TABLE scm.consignment_sales_orders DROP COLUMN processing_date;
    RAISE NOTICE '0286: dropped the dead legacy scm.consignment_sales_orders.processing_date';
  END IF;
END $$;

-- ── 2. Rename the column on both base tables ────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mfg_sales_orders', 'consignment_sales_orders'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass('scm.' || t)
        AND a.attname = 'internal_expected_dd'
        AND a.attnum > 0 AND NOT a.attisdropped
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attrelid = to_regclass('scm.' || t)
        AND a.attname = 'processing_date'
        AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
      EXECUTE format(
        'ALTER TABLE scm.%I RENAME COLUMN internal_expected_dd TO processing_date', t
      );
    END IF;
  END LOOP;
END $$;

-- ── 3. Rename the projection on every dependent view ────────────────────────
-- Written as a catalog sweep rather than naming mfg_sales_orders_with_payment_totals
-- once: the point of 0189/0190/0191 is that a view over this table was missed,
-- and a sweep cannot miss the next one. ALTER VIEW / ALTER MATERIALIZED VIEW
-- RENAME COLUMN is a catalog rename — no DROP, so no lost ACL.
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.oid::regclass AS rel, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'scm'
      AND c.relkind IN ('v', 'm')
      AND a.attname = 'internal_expected_dd'
      AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    IF v.relkind = 'm' THEN
      EXECUTE format(
        'ALTER MATERIALIZED VIEW %s RENAME COLUMN internal_expected_dd TO processing_date', v.rel
      );
    ELSE
      EXECUTE format(
        'ALTER VIEW %s RENAME COLUMN internal_expected_dd TO processing_date', v.rel
      );
    END IF;
    RAISE NOTICE '0286: renamed internal_expected_dd -> processing_date on %', v.rel;
  END LOOP;
END $$;

-- ── 4. The name is also STORED INSIDE DATA, and that is the silent one ──────
-- The API payload key `internalExpectedDd` becomes `processingDate` in the same
-- commit. Three places persist that key as a VALUE, so renaming only the code
-- leaves rows that no longer match anything:
--
--   scm.so_amendments.header_changes (jsonb, mig 0119) — THIS ONE IS DATA LOSS,
--     not cosmetics. applySoAmendment walks the stored keys and skips any key
--     not in AMENDABLE_HEADER_FIELDS (so-revision.ts: the hasOwnProperty guard).
--     A Processing-Date amendment submitted before this deploy and approved
--     after it would be silently DROPPED — approve succeeds, the date never
--     moves, and the audit line does not even mention it.
--   scm.so_amendments.old_header_snapshot (jsonb, same migration) — the
--     before/after diff the approver reads.
--   scm.mfg_so_audit_log.field_changes (jsonb array of {field, from, to}) —
--     the render layer maps `field` to a human label, so an un-migrated row
--     would print the raw token `internalExpectedDd` where it used to print
--     "Processing date".
--
-- This renames the key, never the value, and each statement is guarded so a
-- re-run matches nothing.
DO $$
BEGIN
  IF to_regclass('scm.so_amendments') IS NOT NULL THEN
    UPDATE scm.so_amendments
    SET header_changes =
      (header_changes - 'internalExpectedDd')
      || jsonb_build_object('processingDate', header_changes -> 'internalExpectedDd')
    WHERE header_changes ? 'internalExpectedDd'
      AND NOT header_changes ? 'processingDate';

    UPDATE scm.so_amendments
    SET old_header_snapshot =
      (old_header_snapshot - 'internalExpectedDd')
      || jsonb_build_object('processingDate', old_header_snapshot -> 'internalExpectedDd')
    WHERE old_header_snapshot ? 'internalExpectedDd'
      AND NOT old_header_snapshot ? 'processingDate';
  END IF;

  IF to_regclass('scm.mfg_so_audit_log') IS NOT NULL THEN
    -- WITH ORDINALITY + ORDER BY: an audit row's field list must come back in
    -- the order it was written, or the diff the operator reads gets reshuffled.
    UPDATE scm.mfg_so_audit_log
    SET field_changes = (
      SELECT jsonb_agg(
        CASE WHEN e ->> 'field' = 'internalExpectedDd'
             THEN jsonb_set(e, '{field}', '"processingDate"')
             ELSE e END
        ORDER BY ord
      )
      FROM jsonb_array_elements(field_changes) WITH ORDINALITY AS t(e, ord)
    )
    WHERE jsonb_typeof(field_changes) = 'array'
      AND field_changes @> '[{"field": "internalExpectedDd"}]'::jsonb;
  END IF;
END $$;

-- ── 5. Post-conditions. A half-landed rename is worse than three names ──────
DO $$
DECLARE
  leftovers text;
BEGIN
  IF to_regclass('scm.mfg_sales_orders') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'scm.mfg_sales_orders'::regclass
         AND attname = 'processing_date' AND attnum > 0 AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION '0286: scm.mfg_sales_orders.processing_date is missing after the rename';
  END IF;

  IF to_regclass('scm.consignment_sales_orders') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'scm.consignment_sales_orders'::regclass
         AND attname = 'processing_date' AND attnum > 0 AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION '0286: scm.consignment_sales_orders.processing_date is missing after the rename';
  END IF;

  -- The view must answer to the new name, or every backend read of it 500s.
  IF to_regclass('scm.mfg_sales_orders_with_payment_totals') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'scm.mfg_sales_orders_with_payment_totals'::regclass
         AND attname = 'processing_date' AND attnum > 0 AND NOT attisdropped
     ) THEN
    RAISE EXCEPTION
      '0286: scm.mfg_sales_orders_with_payment_totals does not project processing_date';
  END IF;

  -- Nothing anywhere in scm may still answer to the retired name.
  SELECT string_agg(format('%s.%s', c.oid::regclass, a.attname), ', ')
  INTO leftovers
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE n.nspname = 'scm'
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.attname = 'internal_expected_dd'
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF leftovers IS NOT NULL THEN
    RAISE EXCEPTION '0286: internal_expected_dd still exists on: %', leftovers;
  END IF;

  -- ...and no stored payload key may either.
  IF to_regclass('scm.so_amendments') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM scm.so_amendments
       WHERE header_changes ? 'internalExpectedDd'
          OR old_header_snapshot ? 'internalExpectedDd'
     ) THEN
    RAISE EXCEPTION '0286: scm.so_amendments still stores the internalExpectedDd key';
  END IF;

  IF to_regclass('scm.mfg_so_audit_log') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM scm.mfg_so_audit_log
       WHERE field_changes @> '[{"field": "internalExpectedDd"}]'::jsonb
     ) THEN
    RAISE EXCEPTION '0286: scm.mfg_so_audit_log still stores the internalExpectedDd field name';
  END IF;
END $$;

-- PostgREST caches the schema; every SCM read goes through it. Without this the
-- routes keep asking for a column name the cache still believes in.
NOTIFY pgrst, 'reload schema';
