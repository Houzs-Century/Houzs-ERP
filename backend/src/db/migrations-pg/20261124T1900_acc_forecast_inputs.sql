-- 20261124T1900_acc_forecast_inputs.sql
--
-- WHY. Owner 2026-11-24, 「开始做第 3 步」 of the forecast port from the Hookka
-- ERP (docs/forecast-port-spec.md part 2, build order 3): the Cash Flow's
-- Capex & financing table. Finance keys money it plans to move outside the
-- trading cycle — capex, loans and hire purchase, related-party and director
-- loans, deposits, fixed deposits, shareholder funds — per account and month,
-- + money in, − money out. The Cash Flow's forecast column shows it on that
-- account's line in that month. Forecast only: nothing posts from it.
--
-- One row per company, month and account; a month or an account with nothing
-- keyed has no row (a zero is never stored). The accounts it may name are the
-- ones the Cash Flow layout places under FUNDING IN / (OUT), trade finance
-- aside (its plan is step 5) — checked by the route, not here, because the
-- layout is the owner's to rearrange.
--
-- Additive, idempotent, schema-qualified, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_forecast_inputs;
--   Revert the code first. Dropping the table loses the amounts keyed in the
--   Capex & financing table and nothing in the books (nothing posts from it).
--   GRANTS: none to re-apply.

CREATE TABLE IF NOT EXISTS scm.acc_forecast_inputs (
  company_id   bigint      NOT NULL,
  month        text        NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  account_code text        NOT NULL,
  amount_sen   bigint      NOT NULL CHECK (amount_sen <> 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  PRIMARY KEY (company_id, month, account_code)
);

COMMENT ON TABLE scm.acc_forecast_inputs IS
  'Cash Flow forecast: capex and financing keyed per company, month and account; + money in, - money out, whole sen. Forecast only, nothing posts.';
