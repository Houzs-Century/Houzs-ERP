-- ----------------------------------------------------------------------------
-- 20260909T1000 — a Sales Order can be shared with more than one salesperson.
--
-- Owner 2026-09-09, on the Salesperson Handover panel: "接手的 sales person 可以
-- 选择 multiple 吗？可以让接手的几位 sales person 都有权限". The handover shipped in
-- #2354 moves ONE column to ONE person, because SO row-level visibility is
-- `salesperson_id IN (caller's scope)` (scm/lib/salesScope.ts) and that column
-- holds exactly one uuid.
--
-- TWO COLUMNS, AND THE SPLIT IS THE WHOLE DESIGN:
--
--   collaborator_staff_ids — INPUT. What an operator granted, and the only one
--     anything writes. Empty on every order that was never shared.
--   access_staff_ids       — DERIVED. salesperson_id + collaborator_staff_ids,
--     maintained by the trigger below. Every scoped read filters on THIS one.
--
-- WHY DERIVE INSTEAD OF FILTERING ON BOTH. A read that had to ask
-- "salesperson_id is mine OR collaborators overlaps mine" is a PostgREST
-- `or=(...)` built by string concatenation, with the scope's uuids appearing
-- inside BOTH an `in.(a,b)` list and an `ov.{a,b}` array literal — two kinds of
-- comma nesting inside one or= term, which is exactly the sort of thing that
-- works in testing and then quietly matches the wrong set. Against one derived
-- column the filter is a single `ov` and every call site is a one-word swap:
-- `.in('salesperson_id', scope)` becomes `.overlaps('access_staff_ids', scope)`,
-- same shape, same fail-closed behaviour for the match-nothing sentinel, and
-- rows with a NULL salesperson_id stay invisible exactly as they are today.
--
-- WHY A TRIGGER AND NOT APPLICATION CODE. `salesperson_id` has many writers —
-- SO create, the header PATCH, the bulk handover, and sync-ac-delta's header
-- lane copying back from AutoCount. A derived column maintained in TypeScript
-- would be correct until the first writer that forgot, and the symptom of
-- forgetting is an order nobody can see. The trigger cannot be bypassed.
--
-- WHY ARRAYS ON THE HEADER, NOT A CHILD TABLE. The read pattern decides it.
-- Every scoped SO read is a LIST filtered by the caller's scope, so a child
-- table would have to become a join or an `IN (<every shared doc_no>)` built per
-- request — a rep sharing 500 orders would put 500 doc numbers in a PostgREST
-- query string. Overlap against an array is bounded by the number of PEOPLE in
-- the caller's scope (typically one), never by the number of orders.
--
-- The cost is that no per-grant metadata (who granted, when) lives here. That is
-- deliberate: the SO audit log records the change with actor and timestamp
-- (`recordSoAudit`, field `collaboratorStaffIds`), which is the record anybody
-- would actually read.
--
-- ATTRIBUTION IS NOT TOUCHED, BY OWNER RULING. Asked who the account book should
-- name when orders are shared with several people, the owner chose 全部平等，
-- 不设主 — equal access, no primary among them. So `salesperson_id` and `agent`
-- keep whatever the handover (or the original sale) put there, this column only
-- ever GRANTS access, and nothing here reaches AutoCount: there is no column on
-- the AutoCount side a co-owner could map to. A resignation that also needs the
-- book to stop naming the departed rep still uses "Hand them to", unchanged.
--
-- SECOND FILE REQUIRED: the Sales Order LIST reads the VIEW
-- scm.mfg_sales_orders_with_payment_totals, which ENUMERATES its columns, so
-- columns added here are invisible to the list until that view is recreated.
-- That is the SCM view trap (backend/docs/scm-view-trap-coe.md) and it is
-- 20260909T1001, kept separate because recreating the view carries real risk and
-- this file cannot fail.
--
-- REVERSAL: run 20260909T1001's reversal first (the view must stop naming the
-- columns before they can go), then DROP TRIGGER + DROP FUNCTION + the two DROP
-- COLUMNs. Ship it as a NEW migration; this file is checksummed the moment it
-- reaches prod.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- NOT NULL DEFAULT '{}' is metadata-only on PG 11+ (constant default, no table
-- rewrite) and saves every read site from a null check.
ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS collaborator_staff_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS access_staff_ids       uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN scm.mfg_sales_orders.collaborator_staff_ids IS
  'INPUT. scm.staff uuids granted SEE + EDIT on this order in addition to salesperson_id. Access only: no attribution, no commission, nothing AutoCount reads. See docs/modules/so-handover.md.';

COMMENT ON COLUMN scm.mfg_sales_orders.access_staff_ids IS
  'DERIVED, trigger-maintained: salesperson_id + collaborator_staff_ids. The column every row-level SO scope filter overlaps against. Never write it directly.';

-- ── The derived column ──────────────────────────────────────────────────────
-- DISTINCT so a collaborator who is also the salesperson appears once; the
-- salesperson is skipped when NULL, which keeps an unattributed order's array
-- empty and therefore invisible to every scoped caller — the behaviour
-- `.in('salesperson_id', scope)` has today for a NULL.
CREATE OR REPLACE FUNCTION scm.mfg_so_sync_access_staff_ids()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.access_staff_ids := (
    SELECT COALESCE(array_agg(DISTINCT s), '{}'::uuid[])
      FROM unnest(
        CASE WHEN NEW.salesperson_id IS NULL THEN '{}'::uuid[]
             ELSE ARRAY[NEW.salesperson_id] END
        || COALESCE(NEW.collaborator_staff_ids, '{}'::uuid[])
      ) AS s
     WHERE s IS NOT NULL
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mfg_so_sync_access_staff_ids ON scm.mfg_sales_orders;

-- BEFORE, so the row is corrected on its way in rather than rewritten after.
-- UPDATE is narrowed by an OF clause because without one every SO update would
-- re-run this, and the SO header is one of the hottest write paths in the
-- system. The list is the two source columns PLUS access_staff_ids itself: the
-- derived column is not supposed to be written by anything, and naming it here
-- is what makes that true rather than merely intended — a write that touched
-- ONLY access_staff_ids would otherwise not fire the trigger and would persist
-- whatever it said, which is a row-level permission set by a typo.
CREATE TRIGGER trg_mfg_so_sync_access_staff_ids
  BEFORE INSERT OR UPDATE OF salesperson_id, collaborator_staff_ids, access_staff_ids
  ON scm.mfg_sales_orders
  FOR EACH ROW
  EXECUTE FUNCTION scm.mfg_so_sync_access_staff_ids();

-- Backfill: every existing row is salesperson_id alone (no order is shared yet).
-- Written directly rather than by touching the rows through the trigger, because
-- an UPDATE of every SO header would bloat the table for no reason.
UPDATE scm.mfg_sales_orders
   SET access_staff_ids = ARRAY[salesperson_id]
 WHERE salesperson_id IS NOT NULL
   AND access_staff_ids = '{}';

-- GIN is the index type for array overlap; the scope filter is
-- `access_staff_ids && ARRAY[...]` (PostgREST `ov`), which cannot use a btree.
-- NOT partial: unlike collaborator_staff_ids this column is populated on nearly
-- every row, and it is the one every scoped list read hits.
CREATE INDEX IF NOT EXISTS idx_scm_mfg_so_access_staff_ids
  ON scm.mfg_sales_orders USING GIN (access_staff_ids);
