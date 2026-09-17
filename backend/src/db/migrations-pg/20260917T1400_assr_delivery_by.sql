-- 20260917T1400_assr_delivery_by.sql
-- REVERSAL:
--   ALTER TABLE assr_cases DROP COLUMN IF EXISTS delivery_by;
--   The column is new and nullable; dropping it loses ONLY the own-team /
--   supplier marker on the delivery-back leg. The case, its do_date and its
--   delivery_order stay. GRANTS: none touched — ALTER TABLE keeps the ACL.
--
-- WHAT THIS IS FOR (owner 2026-09-17). A Service Case's three logistics legs —
-- inspection, pickup, delivery — belong on the HC Delivery Google sheet ONLY
-- when OUR OWN team drives them; a supplier / 3PL leg must not appear there.
-- Inspection already carries inspection_by ('own' | 'supplier') and pickup
-- carries pickup_by ('customer' = our team collects | 'supplier'); the
-- delivery-back leg had no such marker, so this adds it. The delivery-sheet
-- ASSR feed emits a leg only when its marker says own-team AND its date is set.
--
--   assr_cases.delivery_by   'own'      = our team delivers (eligible to sync)
--                            'supplier' = supplier / 3PL delivers (never synced)
--                            NULL       = not yet confirmed (never synced)
--
-- 3PL is a later value (owner: 后期先不做); the column is text, so adding it is
-- a UI change only — no migration.
SET search_path = public;

ALTER TABLE assr_cases ADD COLUMN IF NOT EXISTS delivery_by text;
