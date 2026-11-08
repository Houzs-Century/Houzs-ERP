-- 20261106T0900_assr_leg_cancelled_dates.sql
-- REVERSAL: ALTER TABLE public.assr_cases DROP COLUMN IF EXISTS pickup_cancelled_at; ALTER TABLE public.assr_cases DROP COLUMN IF EXISTS inspection_cancelled_at; ALTER TABLE public.assr_cases DROP COLUMN IF EXISTS delivery_cancelled_at;
--   Dropping these loses only the board-set "this leg was cancelled" marker; the
--   leg then reappears on the board (assrBoardLegs stops skipping it). GRANTS:
--   none touched (adding nullable columns changes no grants).
--
-- WHY (owner 2026-11-06). The board's per-leg status control is a dropdown —
-- Delivered or Cancelled. Delivered stamps actual_* (mig 20261105T0900). Cancelled
-- means that leg's trip was called off: it is DROPPED from the board and recorded,
-- leg-only, never closing the case. Each leg needs its own cancelled stamp, mirror
-- of the actual_* delivered markers.
--
-- HOW USED. The board's leg status dropdown stamps the leg's cancelled_at (pickup ->
-- pickup_cancelled_at, inspection -> inspection_cancelled_at, delivery ->
-- delivery_cancelled_at). assrBoardLegs (scm/lib/assr-board-scope.ts) skips any leg
-- whose cancelled_at is set, so the leg no longer renders. Selecting Delivered or
-- clearing the dropdown clears it.
--
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; the pg-migrate runner
-- owns ONE transaction and splits on ';\n'. assr_cases lives in PUBLIC; its date
-- columns are TEXT, so these match actual_pickup_at. Timestamp is the next free one
-- over main at write time; re-pick it at MERGE time if a later migration lands first.
SET search_path = public;

ALTER TABLE public.assr_cases ADD COLUMN IF NOT EXISTS pickup_cancelled_at text;

ALTER TABLE public.assr_cases ADD COLUMN IF NOT EXISTS inspection_cancelled_at text;

ALTER TABLE public.assr_cases ADD COLUMN IF NOT EXISTS delivery_cancelled_at text;

COMMENT ON COLUMN public.assr_cases.pickup_cancelled_at IS 'ISO date the pickup leg was cancelled on the Delivery Planning board (board status dropdown). A cancelled leg is dropped from the board; leg-only, does not close the case.';

COMMENT ON COLUMN public.assr_cases.inspection_cancelled_at IS 'ISO date the own-team inspection leg was cancelled on the Delivery Planning board. Dropped from the board; leg-only, does not close the case.';

COMMENT ON COLUMN public.assr_cases.delivery_cancelled_at IS 'ISO date the delivery-back leg was cancelled on the Delivery Planning board. Dropped from the board; leg-only, does not close the case.';
