-- customer_pickup_at — the date WE go to the customer's house to
-- collect the faulty item, mirroring supplier_pickup_at (when the 3PL
-- collected the item from the supplier). Nullable; the case manager
-- sets it from the Resolution section (desktop + mobile).
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS customer_pickup_at TEXT;
