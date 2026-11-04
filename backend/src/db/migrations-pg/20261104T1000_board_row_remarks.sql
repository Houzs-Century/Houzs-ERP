-- Delivery Planning: Remarks typed inline on the board for the non-SO rows.
-- A service case's legs (customer pickup / own inspection / delivery) each take
-- their own remark, like the per-leg Time Slot (HC-0194). A project takes one
-- board remark shared by its SETUP and DISMANTLE rows; it is NOT
-- projects.schedule_remark, which is the Projects team's schedule note. DP jobs
-- keep scm.dp_orders.remark, so they need no column.
-- Written by PATCH /delivery-planning/{assr,project}/:id/fields.
-- REVERSAL: ALTER TABLE assr_cases DROP COLUMN IF EXISTS pickup_remark,
--   DROP COLUMN IF EXISTS inspection_remark, DROP COLUMN IF EXISTS delivery_remark;
--   ALTER TABLE projects DROP COLUMN IF EXISTS delivery_remark;
--   New and nullable; dropping them loses only the hand-typed remarks. GRANTS: none touched.
SET search_path = public;

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pickup_remark text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS inspection_remark text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS delivery_remark text;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_remark text;
