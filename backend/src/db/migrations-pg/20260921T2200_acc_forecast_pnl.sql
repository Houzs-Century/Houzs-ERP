-- 20260921T2200_acc_forecast_pnl.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.acc_forecast_pnl; — a planning table nothing else
--   references and nothing posts from; dropping it loses the keyed targets and
--   nothing in the books. GRANTS: none to re-apply.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--
-- ONE NEW TABLE, empty. No existing table, row or index is touched. The deployed
-- application keeps working whether or not this has run: the routes that read
-- and write it ship in the same PR, and a company with no rows has no forecast,
-- which is what every company has today.
--
-- WHY IT EXISTS (owner 2026-09-21: 我也需要这个功能 — the Forecast P&L of the
-- Hookka manufacturing ERP, trading edition; 照 P&L 现在那棵树一行一个户口填).
-- One row per month per company: `lines` is the month's keyed targets, account
-- code → { bp } (a share of the month's forecast sales in basis points) or
-- { amtSen } (an amount in sen) — a sales line always an amount, every other
-- line one of the two, never both. The rows are the P&L's own accounts, read
-- from the chart at every read, so a renamed or re-sectioned account follows.
-- The Dashboard draws these beside the statements' actuals; it never writes.

SET search_path = public, scm;

CREATE TABLE IF NOT EXISTS scm.acc_forecast_pnl (
  company_id  bigint      NOT NULL,
  month       text        NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  lines       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (company_id, month)
);
