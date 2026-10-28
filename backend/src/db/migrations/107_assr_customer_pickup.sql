-- D1 test-mirror of migrations-pg/0064_assr_customer_pickup.sql.
-- Adds customer_pickup_at (date we go to the customer's house to
-- collect the faulty item), mirroring supplier_pickup_at (Mig 064,
-- when 3PL collected items from the supplier).
ALTER TABLE assr_cases ADD COLUMN customer_pickup_at TEXT;
