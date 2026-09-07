-- 20260907T2340 — mark a delivery line whose item code the sales order does not
-- carry (ADDITIVE, one boolean, no backfill).
--
-- WHAT. `scm.delivery_order_items.ac_substituted` — true when the AutoCount
-- delivery line this row mirrors ships an item code that is NOT on the sales
-- order the delivery names, because the warehouse substituted the product at
-- dispatch.
--
-- WHY A COLUMN AND NOT A NOTE. The migrated DO importer used to DROP such a row,
-- and when it was a note's only row the whole document silently ceased to exist:
-- DO-001800 and DO-005583 were never created in the ERP, were not refused, were
-- not counted, and the AutoCount reconcile then printed them as
-- "(owner-declined)" — a gap reported as a decision. The owner's ruling
-- (2026-09-07, "改我们的程式，允许换型号") is that the document must come in.
--
-- Carrying it needs somewhere to say the codes DIFFER, or the system quietly
-- asserts a match it does not have. The row's `so_item_id` stays NULL — which
-- ordered line a substitution replaces is a human judgement and inventing it is
-- computing, not copying — so this flag is the only durable record that the row
-- is a substitution rather than an ordinary ad-hoc line. It is queryable, which
-- a sentence inside `description` is not.
--
-- DEFAULT false, so every existing row keeps its current meaning and no reader
-- changes behaviour until something sets it. Writers:
-- backend/scripts/lib/migrated-do-writer.mjs only.
--
-- ── WHY THE RETRY LOOP, and why this file was rewritten before it ever applied.
-- The first version of this migration was a bare ALTER TABLE. It FAILED on
-- production in deploy run 34141376280 (2026-09-07 ~16:14Z) with
-- `canceling statement due to statement timeout`, having waited about two
-- minutes — and because pg-migrate aborts the whole run on a failed file, it
-- blocked every later migration behind it on go-live night.
--
-- The ALTER itself is cheap: since PG 11 an ADD COLUMN with a CONSTANT default
-- is metadata-only (the default lands in pg_attribute.attmissingval), so there
-- is no table rewrite here and never was. What it could not get was the
-- ACCESS EXCLUSIVE LOCK — company 1 was mid-cutover with delivery documents
-- being written continuously, so the ALTER queued behind live transactions
-- until the statement timeout killed it.
--
-- A bare ALTER on a busy table is therefore not a safe migration, it is a
-- coin toss that takes the deploy pipeline down when it loses. This version
-- asks for the lock with a SHORT lock_timeout and retries, so a transient
-- writer costs seconds instead of failing the run. It gives up loudly after
-- ~100s rather than hanging: if the table is busy for that long, a person
-- should choose the moment, not a deploy.
--
-- The file's body is edited rather than superseded because it NEVER APPLIED:
-- pg-migrate runs each file inside one transaction and rolls it back on error,
-- so no `_pg_migrations` row exists for it and there is no checksum to drift
-- against. (Editing an APPLIED file's body is the thing this repo forbids.)
--
-- No BEGIN/COMMIT here: pg-migrate wraps each file in one transaction already,
-- which is the house style of every recent migration in this tree.
--
-- REVERSAL: ALTER TABLE scm.delivery_order_items DROP COLUMN ac_substituted;
--   Reversible in full. Nothing is derived from it and no other column is
--   written differently because of it; the flag is a statement ABOUT rows that
--   are already correct on their own terms, so dropping it loses the marker and
--   nothing else. The same rows remain identifiable by
--   (so_item_id IS NULL AND delivery_orders.migrated_no_stock).

SET LOCAL statement_timeout = '180s';

DO $add_ac_substituted$
DECLARE
  attempt int := 0;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      -- Short, so a live writer costs 3 seconds and not the whole deploy.
      SET LOCAL lock_timeout = '3s';
      ALTER TABLE scm.delivery_order_items
        ADD COLUMN IF NOT EXISTS ac_substituted boolean NOT NULL DEFAULT false;
      -- Inside the same attempt: the ACCESS EXCLUSIVE lock is already held
      -- here, so the comment cannot become a second thing to queue for.
      COMMENT ON COLUMN scm.delivery_order_items.ac_substituted IS
        'AutoCount delivered an item code the named sales order does not carry (substituted at dispatch). so_item_id is deliberately NULL: which ordered line it replaces is a human decision, so the order''s outstanding quantity is unchanged.';
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt >= 20 THEN
        RAISE EXCEPTION
          'ac_substituted: could not acquire ACCESS EXCLUSIVE on scm.delivery_order_items after % attempts (~100s). The table is under continuous write load; re-run the deploy in a quieter window.', attempt;
      END IF;
      PERFORM pg_sleep(2);
    END;
  END LOOP;
END
$add_ac_substituted$;
