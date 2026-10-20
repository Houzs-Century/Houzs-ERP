-- 20261020T1600_assr_pickup_tracking.sql
-- REVERSAL:
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS pickup_status;
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS actual_pickup_at;
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS pickup_pic;
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS item_location;
--   The columns are new and nullable; dropping them loses only the pickup
--   tracking typed on the Pickup / Return step. GRANTS: none touched.
--
-- HC-0129 (Operation Dept, 2026-10-20): the Pickup / Return step tracks the
-- customer pickup itself. The scheduled (ETA) date is the existing
-- customer_pickup_at; these add the rest. Allowed values are checked at the
-- API (scm/shared/assr-pickup-tracking.ts), not by a CHECK constraint.
--   pickup_status     'pending' | 'scheduled' | 'completed' | NULL
--   actual_pickup_at  YYYY-MM-DD the item was actually collected
--   pickup_pic        free text: driver / supplier / logistics
--   item_location     'customer' | 'warehouse' | 'supplier' | NULL
SET search_path = public;

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pickup_status text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS actual_pickup_at text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pickup_pic text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS item_location text;
