-- 20261014T1810_scm_hr_part_time_rates.sql
-- REVERSAL: ALTER TABLE scm.hr_commission_config
--   DROP COLUMN IF EXISTS part_time_commission_bps,
--   DROP COLUMN IF EXISTS part_time_day_rate_sen,
--   DROP COLUMN IF EXISTS part_time_wifi_sen;
--   Revert the code first (routes/hr.ts reads and writes them; routes/hr-part-time-pay.ts
--   prices every sheet from them).
--
-- WHAT THIS CHANGES, and why it is safe to run against production: three
-- additive columns with defaults on a table of one row per company; nothing
-- else is written.
--
-- WHY (owner 2026-10-14, part-time sales pay): what a part-time salesperson is
-- paid for an event — 2% of their sales (nothing when they sold nothing),
-- RM 120 for each day they logged into the POS, and one RM 20 WiFi allowance
-- per event — lives in HR Settings beside the other rates, so it can be
-- changed without code. The defaults are the figures the owner stated.

SET search_path = public, scm;

ALTER TABLE scm.hr_commission_config ADD COLUMN IF NOT EXISTS part_time_commission_bps integer NOT NULL DEFAULT 200;
ALTER TABLE scm.hr_commission_config ADD COLUMN IF NOT EXISTS part_time_day_rate_sen   bigint  NOT NULL DEFAULT 12000;
ALTER TABLE scm.hr_commission_config ADD COLUMN IF NOT EXISTS part_time_wifi_sen       bigint  NOT NULL DEFAULT 2000;

NOTIFY pgrst, 'reload schema';
