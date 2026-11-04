-- DP (manual job) rows get an inline Time Slot on the Delivery Planning board,
-- like an SO row's (owner 2026-10-31). An SO's slot lives on its DO
-- (delivery_orders.time_range); a DP job has no DO, so its slot lives here on the
-- order itself. Additive text column, written by PATCH /delivery-planning/dp/:id/fields.
-- REVERSAL: ALTER TABLE scm.dp_orders DROP COLUMN IF EXISTS time_range;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS time_range text;
