-- 20261105T0900_assr_actual_leg_done_dates.sql
-- REVERSAL: ALTER TABLE public.assr_cases DROP COLUMN IF EXISTS actual_inspection_at; ALTER TABLE public.assr_cases DROP COLUMN IF EXISTS actual_delivery_at;
--   Dropping these loses only the board-set "this leg is Delivered" marker for
--   the inspection and delivery legs; the board falls back to marking those legs
--   Delivered by case closure / stage as it did before. The pickup leg already
--   had its own marker (actual_pickup_at), untouched here. GRANTS: none touched
--   (adding nullable columns to an existing table changes no grants).
--
-- WHY (owner 2026-11-05: "我要和SO一样 / 板上直接标 Delivered"). A Service Case's
-- fleet legs on the Delivery Planning board could only turn Delivered the way the
-- case itself finished: pickup via actual_pickup_at (set by the crew POD),
-- inspection via a past stage, and the DELIVERY leg ONLY when the whole case was
-- closed. Logistics had no way to mark a leg Delivered from the board — the
-- delivery-back leg especially. Owner ruling: marking a leg Delivered records
-- THAT leg only; it must NOT close the case (closure stays a separate action in
-- the ASSR module). So each leg needs its OWN "actually done" stamp.
--
-- HOW USED. The board's "Mark Delivered" per-leg action stamps the leg's actual_*
-- date: pickup -> actual_pickup_at (already here), inspection -> actual_inspection_at,
-- delivery -> actual_delivery_at. assrBoardLegs (scm/lib/assr-board-scope.ts) then
-- reads these so a leg shows DELIVERED independent of the case's closed_at.
--
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; the pg-migrate runner
-- owns ONE transaction and splits on ';\n'. assr_cases lives in PUBLIC; its date
-- columns are TEXT (YYYY-MM-DD / ISO), so these match actual_pickup_at. Timestamp
-- is the next free one over main at write time; re-pick at MERGE time if a later
-- migration lands first.
SET search_path = public;

ALTER TABLE public.assr_cases ADD COLUMN IF NOT EXISTS actual_inspection_at text;

ALTER TABLE public.assr_cases ADD COLUMN IF NOT EXISTS actual_delivery_at text;

COMMENT ON COLUMN public.assr_cases.actual_inspection_at IS 'ISO date the own-team inspection leg was marked Delivered on the Delivery Planning board (board "Mark Delivered"). Independent of case closure; mirrors actual_pickup_at for the pickup leg.';

COMMENT ON COLUMN public.assr_cases.actual_delivery_at IS 'ISO date the delivery-back leg was marked Delivered on the Delivery Planning board (board "Mark Delivered"). Independent of case closure (owner 2026-11-05: marking a leg Delivered does NOT close the case).';
