-- ----------------------------------------------------------------------------
-- 20260924T1600 — record WHICH DAY of its fair a sales order was written on.
--
-- WHY. The fair picker records which EVENT an order belongs to (`project_id`,
-- `fair_match`), but not which day of it. The owner asked for that day
-- (2026-09-24): the event runs 7-9, the salesperson picks the event, then picks
-- 7, 8 or 9 — 「这样我就可以确切知道他这张单是在哪一天开的」.
--
-- `so_date` cannot answer it. It is the day the order was KEYED, and measured on
-- production on 2026-09-24, of Houzs Century's 101 event-linked orders dated
-- from 2026-08-25, 73 were keyed after their fair had closed and only 28 during
-- it (every one of those fairs ran more than one day).
--
-- NULL stays NULL on every existing row ON PURPOSE: the day was never captured,
-- and stamping `so_date` into it would record a guess as a fact for 73 of 101.
--
-- Written only by the SO create / header PATCH path, and only as a day inside
-- the picked event's period and not after the order date
-- (scm/lib/fair-options.ts::fairDayOnSave). Detail read only — deliberately NOT
-- in the list's HEADER column set, so the payment-totals view is untouched.
--
-- REVERSAL: ALTER TABLE scm.mfg_sales_orders DROP COLUMN IF EXISTS fair_date;
--           (Additive and nullable — dropping it loses the recorded days but no
--           money, no stock and no document.)
--
-- Verified against: production schema (anogrigyjbduyzclzjgn) read 2026-09-24 via
-- the Supabase MCP — scm.mfg_sales_orders has so_date (date), project_id and
-- fair_match, and no column named fair_date.
-- ----------------------------------------------------------------------------

ALTER TABLE scm.mfg_sales_orders
  ADD COLUMN IF NOT EXISTS fair_date date;

COMMENT ON COLUMN scm.mfg_sales_orders.fair_date IS
  'The day of the picked fair this order was written on (a day inside the event, never after so_date). NULL = not recorded: no event picked, or created before 2026-09-24. See scm/lib/fair-options.ts::fairDayOnSave.';
