-- D1 test mirror of migrations-pg/20261020T1600_assr_pickup_tracking.sql.
ALTER TABLE assr_cases ADD COLUMN pickup_status TEXT;
ALTER TABLE assr_cases ADD COLUMN actual_pickup_at TEXT;
ALTER TABLE assr_cases ADD COLUMN pickup_pic TEXT;
ALTER TABLE assr_cases ADD COLUMN item_location TEXT;
