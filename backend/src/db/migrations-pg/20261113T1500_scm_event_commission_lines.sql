-- 20261113T1500_scm_event_commission_lines.sql
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.event_commission_lines;
--   Revert the code first (routes/acc-event-commission.ts reads and writes it;
--   POST /acc-events/commission/lines and /lines/remove). Dropping it takes
--   Finance's own lines out of the open months; a closed month keeps what it
--   froze, and the first open month takes the difference back as its adjustment.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table; nothing existing is altered.
-- Verified against: production, in a rolled-back transaction (run-script.yml
-- run 43383987732, try-commission-lines.mjs on acc/ec-finance-lines-check): the
-- table, its row security, grants and index, and the app's own add / refuse /
-- read / remove of a line on October 2026 with it — 10 checks passed, nothing kept.
--
-- WHY (owner 2026-11-13, Event Commission, 「做」): two upsales HR pays in October
-- were made before the orders came into the ERP (HC-SO-011254 and HC-SO-004110
-- were raised in AutoCount), so no change of theirs is dated here and the page
-- cannot count them. Finance types such an amount itself:
--   a line = an order, the month it is paid in, an amount of goods (more than 0
--   adds commission, less than 0 takes it back) and the reason.
-- The report pays it in that month at the order's own rate, beside what it works
-- out (lib/event-commission.ts withManualLines); closing the month freezes it.
-- Only an open month takes a line or gives one up. Each add and removal is
-- written to the order's own History (scm.mfg_so_audit_log via so-audit).

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.event_commission_lines (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id  bigint      NOT NULL REFERENCES public.companies(id),
  so_doc_no   text        NOT NULL,
  month       date        NOT NULL CHECK (extract(day FROM month) = 1),
  goods_sen   bigint      NOT NULL CHECK (goods_sen <> 0),
  reason      text        NOT NULL CHECK (btrim(reason) <> ''),
  added_by    text        NULL,
  added_at    timestamptz NOT NULL DEFAULT now()
);

-- A report reads a company's lines; a month's lines are found by month.
CREATE INDEX IF NOT EXISTS event_commission_lines_company_month_ix
  ON scm.event_commission_lines (company_id, month);

-- Same as 20261112T1300: RLS on, no policies; the Worker's service_role bypasses RLS.
ALTER TABLE scm.event_commission_lines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.event_commission_lines TO service_role;

NOTIFY pgrst, 'reload schema';
