-- 20261029T1600_acc_logistics_settings.sql
-- REVERSAL: revert the code first (scm/routes/acc-logistics.ts, the Logistics cost
--   tab). Then:
--     DROP TABLE IF EXISTS scm.acc_logistics_settings;
--   A company that ticked its own list loses it and reads the chart's default again.
--   GRANTS: none to re-apply — like scm.acc_official_receipts, the table rides the
--   scm schema's default privileges (service_role); this file grants nothing.
-- Verified against: PENDING — the production trial fills this line in before merge.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new, empty
-- table under a new name. Nothing existing is read, written or altered.
--
-- WHY (owner 2026-10-29: 物流报告 按地区、每趟、setup & dismantle —「都需要」;
-- 自己罗厘的成本（油、过路费、司机）就默认 internal 成本…这些费用也要算 →
-- 「那就先算 overall … trip 除成本」). The Logistics cost report divides a month's
-- own-lorry cost by the month's trips. WHICH accounts are that cost is Finance's
-- call: the chart already books fuel / toll / parking and upkeep per lorry
-- (900-P006 … 900-U011), and a driver salary account counts once Finance ticks it.
-- Until a company ticks its own list, the report reads the chart's default (expense
-- accounts naming a lorry or one of our plates — scm/lib/logistics-cost.ts).

CREATE TABLE IF NOT EXISTS scm.acc_logistics_settings (
  company_id        bigint PRIMARY KEY REFERENCES public.companies (id),
  own_cost_accounts text[] NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text
);
