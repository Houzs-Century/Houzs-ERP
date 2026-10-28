-- 0170_project_finance_lines_company_id.sql
--
-- Owner audit 2026-07-22: GET /api/finance/pnl scoped REVENUE by the active
-- company (rawSales pinned by `AND company_id = ?`) but NOT costs — every
-- caller saw their own revenue minus BOTH companies' project + service costs.
-- The rendered P&L was therefore internally inconsistent: A's profit line
-- silently absorbed B's project costs, and vice versa. Financial reporting
-- distorted for the exact routine question P&L exists to answer.
--
-- The two cost sources at fault:
--   • project_finance_lines — this table has NO company_id column today
--   • assr_cases            — column exists (mig 0083), route just didn't
--                             filter on it
--
-- This migration closes the first gap by adding project_finance_lines.company_id
-- + a backfill from the parent projects.company_id. rawProjectCost + the two
-- INSERT sites (services/projects.ts createLedgerLine +
-- services/projectCostRates.ts recomputeAutoCostLines) then scope on it. The
-- assr_cases side is a route-only tighten (no schema).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + backfill only rows still NULL.

ALTER TABLE project_finance_lines
  ADD COLUMN IF NOT EXISTS company_id integer;

-- Backfill from parent project. Runs once (subsequent runs match no rows
-- because every existing pfl now has a company_id stamped). NEW rows must
-- stamp company_id at INSERT (handled in application code) — no default here,
-- because "default to Houzs" would silently re-open the leak this fix closes
-- if a caller ever forgot to stamp.
UPDATE project_finance_lines pfl
   SET company_id = p.company_id
  FROM projects p
 WHERE pfl.project_id = p.id
   AND pfl.company_id IS NULL
   AND p.company_id IS NOT NULL;

-- Index to keep the scoped rawProjectCost SELECT off a table scan — the
-- existing idx_pfl_project (project_id, kind, category) doesn't lead with
-- company_id, so a per-company aggregate reads every row and filters in JS.
CREATE INDEX IF NOT EXISTS idx_pfl_company_kind ON project_finance_lines(company_id, kind);
