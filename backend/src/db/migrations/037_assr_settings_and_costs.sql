-- 037_assr_settings_and_costs.sql
-- ASSR module enhancements:
--   1) `customer_amount` — revenue side of cost tracking (already had
--      `po_amount` for the supplier side). Lets the case carry a full
--      gross-margin picture once both numbers are filled.
--   2) The default-assignee setting lives in `system_settings` under
--      key `assr_default_assignee_id` — no schema change for that one;
--      the row is created lazily by PUT /api/assr/settings the first
--      time an admin saves it.

ALTER TABLE assr_cases ADD COLUMN customer_amount REAL;
