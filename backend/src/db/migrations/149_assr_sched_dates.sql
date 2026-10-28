-- D1 test mirror of migrations-pg/0282_assr_sched_dates.sql.
ALTER TABLE assr_cases ADD COLUMN sched_inspection_date TEXT;
ALTER TABLE assr_cases ADD COLUMN sched_pickup_date TEXT;
ALTER TABLE assr_cases ADD COLUMN sched_delivery_date TEXT;
