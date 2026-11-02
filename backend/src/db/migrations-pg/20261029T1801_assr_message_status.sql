-- 20261029T1801_assr_message_status.sql
-- Delivery Planning: let the Service-Case (ASSR) rows carry a hand-set
-- customer-message follow-up status (owner 2026-10-29: the non-SO job types
-- must be adjustable — message, date, driver). Free TEXT, one of the 23
-- workflow values or NULL; the allowed set is validated in the
-- /delivery-planning/:type/:id/fields route.
-- The board still OVERLAYS the Service-Arrangement WhatsApp reply on top of this
-- (overlayAssrChatState) when the customer has answered, so a hand-set status
-- shows until the next inbound message re-derives it (owner-accepted).
-- REVERSAL: ALTER TABLE assr_cases DROP COLUMN IF EXISTS delivery_message_status;
--   New and nullable; dropping it loses only the hand-set status on a service
--   case. GRANTS: none touched — ALTER TABLE keeps the ACL.
SET search_path = public;

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS delivery_message_status text;
