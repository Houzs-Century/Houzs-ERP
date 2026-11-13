-- 20261112T1300_scm_event_commission_marks.sql
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.event_commission_marks;
--   Revert the code first (routes/acc-event-commission.ts reads and writes it;
--   POST /acc-events/commission/marks and /marks/undo). Dropping it counts every
--   marked order again in the month it belongs to.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table; nothing existing is altered.
-- Verified against: production, in a rolled-back transaction (run-script.yml
-- run 43155514552, try-commission-marks.mjs on acc/ec-round3-check): the table,
-- its grants and indexes, and the app's own mark / refuse / read / close / undo
-- on October and November 2026 with it — nothing kept.
--
-- WHY (owner 2026-11-12, Event Commission: 「然后我要有两个按钮 1个这张单不要算，
-- 1个是这个算下个月」): Finance marks an order, from the report, in one of two ways:
--   exclude  「这张单不要算」 the order earns no commission in any month. Marked
--            after a month closed, that month's recalculation drops it and the
--            first open month takes it back as that month's adjustment.
--   defer    「这个算下个月」 what the order earns in `month` is paid in the month
--            after it instead. Only an open month can be marked.
-- Undo deletes the mark. Each mark and undo is written to the order's own
-- History (scm.mfg_so_audit_log via so-audit), with the reason when one is given.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.event_commission_marks (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL REFERENCES public.companies(id),
  so_doc_no   text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('exclude', 'defer')),
  month       date        NULL CHECK (month IS NULL OR extract(day FROM month) = 1),
  reason      text        NULL,
  marked_by   text        NULL,
  marked_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_commission_marks_month CHECK ((kind = 'defer') = (month IS NOT NULL))
);

-- One "don't count" per order; one "next month" per order and month.
CREATE UNIQUE INDEX IF NOT EXISTS event_commission_marks_exclude_uq
  ON scm.event_commission_marks (company_id, so_doc_no) WHERE kind = 'exclude';
CREATE UNIQUE INDEX IF NOT EXISTS event_commission_marks_defer_uq
  ON scm.event_commission_marks (company_id, so_doc_no, month) WHERE kind = 'defer';

-- Same as 20261026T1700: RLS on, no policies; the Worker's service_role bypasses RLS.
ALTER TABLE scm.event_commission_marks ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.event_commission_marks TO service_role;

NOTIFY pgrst, 'reload schema';
