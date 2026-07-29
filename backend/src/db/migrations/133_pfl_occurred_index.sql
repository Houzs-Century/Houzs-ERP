-- D1 / SQLite parity for PG migration 0213 — index the finance-line month
-- expression the profitability drill-down bins on: COALESCE(occurred_at,
-- created_at). SQLite supports expression indexes, so this mirrors the PG
-- expression 1:1 for test schema parity.
CREATE INDEX IF NOT EXISTS idx_pfl_occurred
  ON project_finance_lines (COALESCE(occurred_at, created_at));
