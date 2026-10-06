-- 20261006T1300_acc_performance_opex_also.sql
-- REVERSAL: ALTER TABLE scm.acc_company_settings DROP COLUMN IF EXISTS performance_opex_also;
--   Revert the code first: acc/performance-pnl.ts loadPerformanceSettings selects
--   the column and savePerformanceSettings writes it. Dropping it puts 2990's
--   transport back among the Performance P&L's expenses (counted twice: once
--   inside the 16% rate, once as booked).
--   GRANTS: none to re-apply — a column rides its table's grants.
--
-- WHAT THIS CHANGES: one new column on scm.acc_company_settings,
--   performance_opex_also text[] NOT NULL DEFAULT '{}' — the other accounts the
--   Performance P&L's operating-expense rate covers besides
--   performance_opex_account (each with every account under it in the chart).
--   Every existing row reads '{}' (nothing more covered). Then ONE row is set:
--   2990's (company code '2990') covers 900-T004 TRANSPORTATION FEE (and the
--   transport accounts under it) and 900-T008 TRANSPORTATION FEES - OTHERS.
--   The UPDATE touches only a row still at '{}', so a value set from the page
--   before this runs is never overwritten. Houzs has no settings row and gets
--   none: its performance is figured differently (owner: 不做先).
--
-- WHY (owner 2026-10-06): 2990's Performance P&L showed transport as booked
-- while the 16% operating-expense rate already includes it (「已经算在
-- operating expense 16% 了」) — counted twice. Covered accounts leave the
-- expenses, print at nil, and the rate's line names them.
--
-- Verified against: staging (minnapsemfzjmtvnnvdd) via apply_migration before merge.

ALTER TABLE scm.acc_company_settings
  ADD COLUMN IF NOT EXISTS performance_opex_also text[] NOT NULL DEFAULT '{}';

UPDATE scm.acc_company_settings s
   SET performance_opex_also = ARRAY['900-T004', '900-T008']
  FROM public.companies co
 WHERE co.id = s.company_id
   AND co.code = '2990'
   AND s.performance_opex_also = '{}';
