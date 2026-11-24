-- 20261124T1700_acc_forecast_pnl_suppliers.sql
--
-- WHY. Owner 2026-11-24, 「开始做第 1 步」 of the forecast port from the Hookka
-- ERP (docs/forecast-port-spec.md, build order 1): on the Forecast P&L, Finance
-- splits a purchase account's month by supplier. The trade finance plan and the
-- cash flow forecast (later steps) pay each supplier by its own terms, so they
-- need the purchases per supplier, not one figure per account.
--
-- One month's supplier figures, beside the month's `lines`:
--   purchase account code → supplier id (scm.suppliers.id of the same company,
--   or 'other') → { amtSen } (an amount in sen) | { bp } (a share in basis
--   points of the sales the account's own % is of).
-- When an account has supplier figures in a month, its month IS their sum and
-- its own cell in `lines` is superseded (kept, and counted again once its
-- suppliers are cleared). The rule lives in scm/shared/forecast-pnl.ts.
--
-- Additive, idempotent, schema-qualified, no backfill: every existing row reads
-- '{}' (no supplier figures), which is exactly what every month means today.
-- RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.acc_forecast_pnl DROP COLUMN IF EXISTS suppliers;
--   Revert the code first. Dropping the column loses the supplier figures keyed
--   on the Forecast P&L and nothing in the books (the table is a planning grid;
--   nothing posts from it). GRANTS: none to re-apply.

ALTER TABLE scm.acc_forecast_pnl ADD COLUMN IF NOT EXISTS suppliers jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN scm.acc_forecast_pnl.suppliers IS
  'Purchase account code -> supplier id (or other) -> {amtSen} | {bp}. When an account has any, its month is their sum and its own cell in lines is superseded.';

NOTIFY pgrst, 'reload schema';
