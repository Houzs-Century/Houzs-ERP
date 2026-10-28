-- Pickup by (Nico 2026-08-07): who collects the faulty item during the
-- Supplier stage — 'customer' = our logistics collects from the
-- customer's house (fires the Delivery-sheet PICKUP job), 'supplier' =
-- the supplier collects directly (no job). Mirrors inspection_by.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pickup_by text;
