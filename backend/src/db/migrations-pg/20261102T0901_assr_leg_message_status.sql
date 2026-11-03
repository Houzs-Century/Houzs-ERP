-- Delivery Planning: the hand-set customer-message status of a service case is
-- kept per job (customer pickup / own inspection / delivery), not per case, so
-- changing the service-delivery row no longer changes the pickup row (HC-0193).
-- The existing assr_cases.delivery_message_status now belongs to the delivery
-- leg; the two new columns hold the other legs. The UPDATE copies the case's
-- current value onto them once, so no row on the board loses the status it shows today.
-- REVERSAL: ALTER TABLE assr_cases DROP COLUMN IF EXISTS pickup_message_status,
--   DROP COLUMN IF EXISTS inspection_message_status;
--   Loses only the per-leg values of the two non-delivery legs. GRANTS: none touched.
SET search_path = public;

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS pickup_message_status text;
ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS inspection_message_status text;
UPDATE assr_cases
   SET pickup_message_status = delivery_message_status,
       inspection_message_status = delivery_message_status
 WHERE delivery_message_status IS NOT NULL
   AND pickup_message_status IS NULL AND inspection_message_status IS NULL;
