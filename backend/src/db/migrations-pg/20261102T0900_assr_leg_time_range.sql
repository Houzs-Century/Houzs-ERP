-- Delivery Planning: a service case's legs (customer pickup / own inspection /
-- delivery) each take their own Time Slot, typed inline on the board (HC-0194).
-- One nullable text column per leg, like scm.dp_orders.time_range for DP jobs.
-- Written by PATCH /delivery-planning/assr/:id/fields with a jobKind.
-- REVERSAL: ALTER TABLE assr_cases DROP COLUMN IF EXISTS pickup_time_range,
--   DROP COLUMN IF EXISTS inspection_time_range, DROP COLUMN IF EXISTS delivery_time_range;
--   New and nullable; dropping them loses only the hand-typed slots. GRANTS: none touched.
SET search_path = public;

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pickup_time_range text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS inspection_time_range text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS delivery_time_range text;
