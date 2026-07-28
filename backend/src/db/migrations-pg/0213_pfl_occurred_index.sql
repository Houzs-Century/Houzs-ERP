-- 0213_pfl_occurred_index.sql — index the finance-line month expression.
--
-- WHY. The profitability drill-down bins a project's revenue/cost into the
-- month each line was RECOGNISED, using COALESCE(occurred_at, created_at) —
-- occurred_at is the operator-entered date, created_at the fallback. The L2
-- "by month" query GROUPs on substr(COALESCE(occurred_at, created_at), 1, 7)
-- and the L3 "projects in month" query filters on the same expression, both
-- over project_finance_lines. Without an expression index those degrade to a
-- sequential scan of the whole ledger on every drill. This indexes exactly
-- the COALESCE expression they key on.
--
-- Additive and idempotent — safe to re-run.
CREATE INDEX IF NOT EXISTS idx_pfl_occurred
  ON project_finance_lines ((COALESCE(occurred_at, created_at)));
