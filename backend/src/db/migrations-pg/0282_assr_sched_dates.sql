-- Scheduled job dates written back from the HC Delivery sheet
-- (Nico 2026-08-12): dispatch schedules a case's INSPECTION / PICKUP /
-- SERVICE job in Delivery Details; the sheet's Apps Script POSTs each
-- date to /api/assr-form-intake/delivery-dates and it lands here, so
-- the ERP case (and its print copies) show when the visit happens.
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS sched_inspection_date text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS sched_pickup_date text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS sched_delivery_date text;
