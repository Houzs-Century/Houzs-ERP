-- 20261116T1000_assr_leg_amend_reason.sql
-- Amend / reschedule reason per Service-Case leg, mirroring the Sales Order
-- header's amend_reason. Delivery Planning shows ONE row per leg (customer
-- pickup / inspection / delivery), each with its own date, so the reason a leg's
-- date moved is kept PER LEG -- like pickup_remark / inspection_remark /
-- delivery_remark already are. Picked from the preset AMEND_REASONS dropdown or
-- free text; recorded only (it drives no message). Nullable; set from the board's
-- Amend Reason column and the "Set job date" drawer.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pickup_amend_reason TEXT;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS inspection_amend_reason TEXT;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS delivery_amend_reason TEXT;

-- REVERSAL: ALTER TABLE assr_cases DROP COLUMN IF EXISTS pickup_amend_reason; ALTER TABLE assr_cases DROP COLUMN IF EXISTS inspection_amend_reason; ALTER TABLE assr_cases DROP COLUMN IF EXISTS delivery_amend_reason;
