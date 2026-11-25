-- 20261124T2100_acc_tf_plans.sql
--
-- WHY. Owner 2026-11-24, 「开始做第 5 步」 of the forecast port from the Hookka
-- ERP (docs/forecast-port-spec.md part 3, build order 5): the Cash Flow's
-- trade-finance plan. D3 (his, the same day): no limit, each draw repaid about
-- two months after it. Per facility (a liability account named TRADE FINANCE),
-- Finance may set the tenor and the interest per draw (none = 60 days and the
-- recent repayments' rate), names the suppliers the facility pays, and may
-- untick a supplier's due in a month. The forecast draws the ticked dues and
-- repays them a tenor later with their interest. Forecast only: nothing posts.
--
-- One row per company and facility account. `suppliers` is a JSON array of
-- the company's supplier ids; `off` is "YYYY-MM" → supplier ids unticked. The
-- route checks the account is a facility and the ids are the company's.
--
-- Additive, idempotent, schema-qualified, no data. RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_tf_plans;
--   Revert the code first. Dropping the table loses the plan Finance keyed
--   (tenor, rate, suppliers, unticked months) and nothing in the books.
--   GRANTS: none to re-apply.

CREATE TABLE IF NOT EXISTS scm.acc_tf_plans (
  company_id   bigint      NOT NULL,
  account_code text        NOT NULL,
  tenor_days   integer     CHECK (tenor_days BETWEEN 1 AND 400),
  rate_bp      integer     CHECK (rate_bp BETWEEN 0 AND 10000),
  suppliers    jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(suppliers) = 'array'),
  off          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(off) = 'object'),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text,
  PRIMARY KEY (company_id, account_code)
);

-- Only the Worker reads or writes it, like the newest acc tables: row level
-- security on with no policy (the Worker's roles bypass it), the service role
-- granted by name.
ALTER TABLE scm.acc_tf_plans ENABLE ROW LEVEL SECURITY;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.acc_tf_plans TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_tf_plans IS
  'Cash Flow forecast: trade-finance plan per company and facility account - tenor, rate per draw, the suppliers it pays, months unticked. Forecast only, nothing posts.';
