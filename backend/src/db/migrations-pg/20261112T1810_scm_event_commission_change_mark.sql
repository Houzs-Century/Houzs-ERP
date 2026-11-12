-- 20261112T1810_scm_event_commission_change_mark.sql
-- REVERSAL:
--   Revert the code first (routes/acc-event-commission.ts writes kind
--   'exclude_change'; lib/event-commission.ts withUncountedChanges reads it). Then:
--   DELETE FROM scm.event_commission_marks WHERE kind = 'exclude_change';
--   DROP INDEX IF EXISTS scm.event_commission_marks_change_uq;
--   ALTER TABLE scm.event_commission_marks DROP CONSTRAINT event_commission_marks_kind;
--   ALTER TABLE scm.event_commission_marks DROP CONSTRAINT event_commission_marks_month;
--   ALTER TABLE scm.event_commission_marks ADD CONSTRAINT event_commission_marks_kind
--     CHECK (kind IN ('exclude', 'defer'));
--   ALTER TABLE scm.event_commission_marks ADD CONSTRAINT event_commission_marks_month
--     CHECK ((kind = 'defer') = (month IS NOT NULL));
--   Deleting those marks counts the price changes again, in the months they were made.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: the two CHECK
-- constraints on scm.event_commission_marks that name `kind` are replaced by
-- wider ones — every row there today (kind 'exclude' with no month, 'defer' with
-- one) satisfies both — and one partial unique index is added over rows that do
-- not exist yet. No row is read or written; the first-of-month check on `month`
-- is left as it is.
-- Verified against: production, in a rolled-back transaction (run-script.yml
-- run 43202007904, try-commission-change-mark.mjs on acc/ec-change-check): the
-- constraints and the index, and the app's own mark / refuse / read / undo of a
-- price change on October 2026 with it — nothing kept.
--
-- WHY (owner 2026-11-12, Event Commission, on the Upsales / Drop sales table:
-- 「这边不能按不count 吗？」 then 「做 B：只是改价不算」): a third mark on an order,
--   exclude_change  「这次改价不算」 the order's upsales and drop sales of `month`
--                   move no commission, that month or later; the order itself
--                   still earns on its goods less them. Only an open month can
--                   be marked; one per order and month.
-- Undo deletes the mark, as for the other two (20261112T1300).

SET search_path = public, scm;

-- The allowed kinds, and which kinds carry a month. The kind check came with the
-- column, named by Postgres — dropped by what it checks, as 20261026T1000 does.
DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'scm.event_commission_marks'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP EXECUTE format('ALTER TABLE scm.event_commission_marks DROP CONSTRAINT %I', c.conname); END LOOP; END $$;
ALTER TABLE scm.event_commission_marks ADD CONSTRAINT event_commission_marks_kind
  CHECK (kind IN ('exclude', 'defer', 'exclude_change'));
ALTER TABLE scm.event_commission_marks ADD CONSTRAINT event_commission_marks_month
  CHECK ((kind = 'exclude') = (month IS NULL));

-- One "price change not counted" per order and month.
CREATE UNIQUE INDEX IF NOT EXISTS event_commission_marks_change_uq
  ON scm.event_commission_marks (company_id, so_doc_no, month) WHERE kind = 'exclude_change';

NOTIFY pgrst, 'reload schema';
