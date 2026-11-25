-- 20261125T1700_acc_performance_fair_costs.sql
-- REVERSAL: ALTER TABLE scm.acc_company_settings DROP COLUMN IF EXISTS performance_fair;
--   Revert the code first: acc/performance-pnl.ts loadPerformanceSettings selects
--   the column and saveFairRates writes it. Dropping it takes Houzs's fair block off
--   the Performance P&L: its logistics, fair transport and terminal charges go back
--   to as booked. No journal entry depends on it.
--   GRANTS: none to re-apply — a column rides its table's grants.
--
-- WHAT THIS CHANGES: one new nullable column on scm.acc_company_settings,
--   performance_fair jsonb — the fair costs a company keeps on its Performance P&L.
--   Every existing row reads NULL (no fair block). Then ONE row is set: Houzs's
--   (company code 'HOUZS'), and only while it is still NULL, so a value saved from
--   the page before this runs is never overwritten:
--     rental          900-R031 RENTAL - ROADSHOW, 900-R032 RENTAL - EXHIBITION (as booked)
--     setup           900-B003 BOOTH SET UP (as booked)
--     transportBp     300 — 3% of sales excluding service, in place of the Logistics
--                     P&L's own accounts (the chart's Logistics column) and the
--                     drivers' and helpers' pay lines
--     setupDismantle  100 — 1%, in place of 900-T030..T033 TRANSPORT FAIR
--     merchandise     200 — 2%, in place of 900-T009 TERMINAL INTEREST CHARGES
--   The commission (900-C003, its month's bills) joins the block in code.
--
-- WHY (owner 2026-11-25): 「帮我把这些fair的费用单独放一块 就是rental, setup,
-- commission, transport 和 merchandise」; transport is a percentage, the drivers'
-- and helpers' pay inside it (「driver helper的薪水其实都包括在 logistic的3 % 了」),
-- 「多1% 是 for setup & dismantle」; merchandise 2% is his own fair P&L's rate for
-- every brand (public.project_cost_rates.merchandise_pct).

ALTER TABLE scm.acc_company_settings
  ADD COLUMN IF NOT EXISTS performance_fair jsonb;

UPDATE scm.acc_company_settings s
   SET performance_fair = '{"rental": ["900-R031", "900-R032"], "setup": ["900-B003"], "transportBp": 300, "setupDismantleBp": 100, "setupDismantle": ["900-T030", "900-T031", "900-T032", "900-T033"], "merchandiseBp": 200, "merchandise": ["900-T009"]}'::jsonb,
       updated_at = now(),
       updated_by = 'migration 20261125T1700'
  FROM public.companies co
 WHERE co.id = s.company_id
   AND co.code = 'HOUZS'
   AND s.performance_fair IS NULL;

NOTIFY pgrst, 'reload schema';
