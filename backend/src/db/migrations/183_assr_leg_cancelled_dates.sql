-- D1 test mirror of migrations-pg/20261106T0900_assr_leg_cancelled_dates.sql.
ALTER TABLE assr_cases ADD COLUMN pickup_cancelled_at TEXT;
ALTER TABLE assr_cases ADD COLUMN inspection_cancelled_at TEXT;
ALTER TABLE assr_cases ADD COLUMN delivery_cancelled_at TEXT;
