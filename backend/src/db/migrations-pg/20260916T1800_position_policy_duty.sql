-- 20260916T1800_position_policy_duty.sql
-- REVERSAL:
--   ALTER TABLE public.position_policy DROP COLUMN IF EXISTS duty;
--   The code falls back to the name-keyed lists in services/pmsAccess.ts and
--   services/projectGates.ts for a row without a duty, so dropping the column
--   restores the behaviour before this migration exactly.
--
-- Roles & Permissions review 2026-09-16, part B follow-up (1): the project-page
-- (PMS) role, the product-cost viewer, the crew scope and the defect reviewer
-- were still decided by a Title's NAME (pmsAccess.ts regexes and exact-name
-- sets, projectGates.ts prefix). This column stores that "what is this Title's
-- job on a project" answer on the Title's id, editable on Roles & Permissions ›
-- Titles as the Duty column.
--
--   management  → PMS DIRECTOR (every section incl. money)
--   finance     → PMS DIRECTOR + product cost
--   purchasing  → PMS PURCHASING + product cost
--   logistic    → PMS LOGISTIC (edit, no money, no event chat)
--   driver      → PMS DRIVER
--   helper      → PMS DRIVER and crew-scoped (only events they are crewed on)
--   warehouse   → crew-scoped, PMS OTHER
--   other       → PMS OTHER
-- A Title in the sales cohort is PIC / SALES (director profile → DIRECTOR)
-- from its cohort, whatever its duty says. Owner-tier Titles are DIRECTOR.
ALTER TABLE public.position_policy
  ADD COLUMN IF NOT EXISTS duty text NOT NULL DEFAULT 'other'
  CHECK (duty IN ('management', 'finance', 'purchasing', 'logistic', 'driver', 'helper', 'warehouse', 'other'));

-- Seed = what the NAME rules resolved on 2026-09-16, by slug, so nobody's
-- project page changes on deploy (positionPolicyRows.test.ts pins each row
-- against its production name). Two Titles the owner may want to flip on the
-- Titles tab, because their renamed names had stopped matching the regexes:
-- Logistic Admin (PMS role OTHER today; "logistic" would give the LOGISTIC
-- sections) and Procurement/Purchasing (no active member; seeded purchasing
-- because it is the product-cost viewer by name today).
UPDATE public.position_policy SET duty = 'management'
 WHERE position_id IN (SELECT id FROM public.positions WHERE slug IN ('super_admin', 'owner', 'managing_director'));
UPDATE public.position_policy SET duty = 'finance'
 WHERE position_id IN (SELECT id FROM public.positions WHERE slug IN ('finance_manager'));
UPDATE public.position_policy SET duty = 'purchasing'
 WHERE position_id IN (SELECT id FROM public.positions WHERE slug IN ('purchasing'));
UPDATE public.position_policy SET duty = 'driver'
 WHERE position_id IN (SELECT id FROM public.positions WHERE slug IN ('driver'));
UPDATE public.position_policy SET duty = 'helper'
 WHERE position_id IN (SELECT id FROM public.positions WHERE slug IN ('helper'));
UPDATE public.position_policy SET duty = 'warehouse'
 WHERE position_id IN (SELECT id FROM public.positions WHERE slug IN ('storekeeper', 'warehouse_crew_kl'));
