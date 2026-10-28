-- Finance Lines date filter (GET /projects/finance/by-project) filters on
-- COALESCE(occurred_at, created_at) with no supporting index, so a date-ranged
-- query does a full scan of project_finance_lines. After the FAIR PNL backfill
-- (2024 seed + autocost) the table grew enough that the filtered dashboard query
-- times out (504). This expression index matches the WHERE expression exactly so
-- the range scan is index-backed.
CREATE INDEX IF NOT EXISTS idx_pfl_occurred
  ON project_finance_lines (COALESCE(occurred_at, created_at));
