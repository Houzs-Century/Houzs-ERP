-- 20261026T1700_scm_event_commission_closes.sql
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.event_commission_closes;
--   Revert the code first (routes/acc-event-commission.ts reads and writes it;
--   POST /acc-events/commission/close and /reopen). Dropping it reopens every
--   closed month: each is recalculated from today's data again and no month
--   carries an adjustment any more.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new
-- empty table; nothing existing is altered.
-- Verified against: production, in a rolled-back transaction (run-script.yml
-- run 40292854808, try-month-close.mjs): the table, its grants, and the app's
-- own close / read / reopen of September 2026 on it — nothing kept.
--
-- WHY (owner 2026-10-26, Event Commission, 「可以」 to closing a month, Finance
-- only): once a month's commission is paid it must never change. A closed
-- month is served as it was closed; what later moves its orders' commission (a
-- payment dated back into it, a payment deleted, an order moved to another
-- fair or put on hold) is paid in the first open month as that month's
-- adjustment (「X 月调整」). One row per closed month and company:
--   paid     what the month paid each order, per basis
--            {"fair": {"HC-SO-…": sen, …}, "so_date": {…}}
--   carried  the adjustments for earlier closed months it paid when it closed
--            {"fair": [{"month": "2026-09", "docNo": "HC-SO-…", "sen": n}], "so_date": […]}
--   report_fair / report_so_date  the report as closed, what the page shows.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.event_commission_closes (
  id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      bigint      NOT NULL REFERENCES public.companies(id),
  month           date        NOT NULL CHECK (extract(day FROM month) = 1),
  closed_at       timestamptz NOT NULL DEFAULT now(),
  closed_by       text        NULL,
  paid            jsonb       NOT NULL,
  carried         jsonb       NOT NULL,
  report_fair     jsonb       NOT NULL,
  report_so_date  jsonb       NOT NULL,
  CONSTRAINT event_commission_closes_uq UNIQUE (company_id, month)
);

-- Same as 20261024T1400: RLS on, no policies; the Worker's service_role bypasses RLS.
ALTER TABLE scm.event_commission_closes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE scm.event_commission_closes TO service_role;

NOTIFY pgrst, 'reload schema';
