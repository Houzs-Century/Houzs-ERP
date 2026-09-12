-- 20260912T1300_acc_performance_pnl_settings.sql
--
-- REVERSAL: ALTER TABLE scm.acc_company_settings DROP CONSTRAINT IF EXISTS acc_company_settings_opex_rate_chk; ALTER TABLE scm.acc_company_settings DROP COLUMN IF EXISTS performance_opex_rate_bp; ALTER TABLE scm.acc_company_settings DROP COLUMN IF EXISTS performance_opex_account;
--   Nothing else refers to the two columns; the report computes live and
--   stores nothing.
--
-- WHAT THIS CHANGES, and why it is safe to run against production:
--   Two columns on the per-company settings row (docs/bugs/0835, the
--   Performance P&L; owner 2026-09-12: expense 的 operating 要根据 sales 的 16%
--   来算 … 16% 要设计成可调 … 只取代 900-O001):
--     performance_opex_rate_bp  the operating-expense rate the report applies
--                               to sales excluding service, in basis points
--                               (1600 = 16%), 0–10000;
--     performance_opex_account  the ledger account that rate stands in for
--                               (the owner's 900-O001 OPERATING EXPENSE).
--   Both have defaults, so every existing row (2990's switch row) reads the
--   owner's numbers without an UPDATE; a company with no row yet reads the
--   same defaults in code. No data moves; nothing is dropped.
--
-- Reversal / Verified against: in the PR body, where the check reads them.

ALTER TABLE scm.acc_company_settings
  ADD COLUMN IF NOT EXISTS performance_opex_rate_bp integer NOT NULL DEFAULT 1600,
  ADD COLUMN IF NOT EXISTS performance_opex_account text NOT NULL DEFAULT '900-O001';

ALTER TABLE scm.acc_company_settings DROP CONSTRAINT IF EXISTS acc_company_settings_opex_rate_chk;
ALTER TABLE scm.acc_company_settings
  ADD CONSTRAINT acc_company_settings_opex_rate_chk CHECK (performance_opex_rate_bp BETWEEN 0 AND 10000);

COMMENT ON COLUMN scm.acc_company_settings.performance_opex_rate_bp IS
  'Performance P&L (docs/bugs/0835): operating expense as basis points of sales excluding service (1600 = 16%).';
COMMENT ON COLUMN scm.acc_company_settings.performance_opex_account IS
  'Performance P&L (docs/bugs/0835): the ledger account the computed operating expense stands in for (900-O001).';
