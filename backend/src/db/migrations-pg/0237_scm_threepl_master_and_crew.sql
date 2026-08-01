-- 0237_scm_threepl_master_and_crew.sql — the 3PL company master becomes a real
-- vendor record, and its CREW joins the fleet the way its lorries already do.
--
-- WHY. Owner, 2026-08-01: a 3PL is registered once with its full company
-- particulars (SSM, contact person, office line) AND its fleet — plates, driver
-- contacts, helper ICs — and that fleet then appears in the Fleet module marked
-- OUTSOURCE. Migration 0210 built the company master and linked LORRIES to it,
-- and said in its own header that "driver/helper company links follow when their
-- UI does". This is that migration.
--
-- WHAT THIS ADDS
--   1. scm.threepl_companies — the company particulars 0210 left out
--      (registration_no = SSM, office_phone, email, address).
--   2. scm.drivers.threepl_company_id / scm.helpers.threepl_company_id — the
--      crew -> carrier-company link, mirroring scm.lorries.threepl_company_id
--      (0210) exactly: nullable, ON DELETE SET NULL.
--   3. One rate card per carrier company (owner's call, 2026-08-01) — a PARTIAL
--      unique index, so the many own-fleet cards (carrier_company_id IS NULL)
--      are unaffected.
--
-- WHY ONE TABLE, NOT A SEPARATE 3PL FLEET. Owner's call on 2026-08-01: a 3PL's
-- driver/helper/lorry goes into the SAME masters as our own, flagged outsource
-- and pointed at its company. scm.lorries has been the unified fleet master
-- since 0053 (mig 0055 dropped a duplicate public.lorries once — this module
-- does not repeat that), scm.trips.is_outsourced already derives from
-- lorries.is_internal, and Module C prices per carrier company. A parallel 3PL
-- fleet would fork assignment, costing and the rate card all at once.
--
-- THE OUTSOURCE FLAG IS NOT SET HERE. in_house / is_internal is written by the
-- route on insert and patch (threepl-companies.ts, drivers.ts, helpers.ts,
-- lorries.ts): a row with a threepl_company_id is forced outsource. A CHECK
-- cannot express it across the two columns without pinning existing rows, and a
-- trigger would be a second writer of a field the routes already own.
--
-- BACKFILL — deliberately none. No driver or helper carries a carrier link
-- today (the column is new), and the existing outsourced rows cannot be
-- attributed to a company without a human saying which. They stay unlinked and
-- outsourced, exactly as they are.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, one
-- transaction. RE-CHECK THE NUMBER AT MERGE — 0237 was next free above 0236.

SET search_path = scm, public;

-- 1. Company particulars. All nullable: a solo operator with a phone number and
--    no SSM is still a carrier you dispatch to, and refusing to record him would
--    push the dispatcher back to a free-text lorry row.
ALTER TABLE scm.threepl_companies
  ADD COLUMN IF NOT EXISTS registration_no TEXT NULL,
  ADD COLUMN IF NOT EXISTS office_phone    TEXT NULL,
  ADD COLUMN IF NOT EXISTS email           TEXT NULL,
  ADD COLUMN IF NOT EXISTS address         TEXT NULL;

-- SSM numbers are unique per registrar, so a duplicate inside one tenant is a
-- double-registration. Partial: the many carriers with no SSM on file collide
-- with nobody. Note this does NOT constrain across tenants — two Houzs
-- companies may each legitimately register the same vendor.
CREATE UNIQUE INDEX IF NOT EXISTS threepl_companies_registration_uq
  ON scm.threepl_companies (company_id, registration_no)
  WHERE registration_no IS NOT NULL;

-- 2. The crew -> carrier-company link. Same shape and same delete semantics as
--    scm.lorries.threepl_company_id (0210): removing a carrier DETACHES its crew,
--    never deletes them — a driver who did our deliveries stays in the history.
ALTER TABLE scm.drivers
  ADD COLUMN IF NOT EXISTS threepl_company_id UUID NULL
    REFERENCES scm.threepl_companies(id) ON DELETE SET NULL;

ALTER TABLE scm.helpers
  ADD COLUMN IF NOT EXISTS threepl_company_id UUID NULL
    REFERENCES scm.threepl_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_drivers_threepl_company
  ON scm.drivers (threepl_company_id);
CREATE INDEX IF NOT EXISTS idx_helpers_threepl_company
  ON scm.helpers (threepl_company_id);

-- 3. One rate card per carrier company. The card IS the company's price list, so
--    the New Rate Card form no longer asks for a name (owner, 2026-08-01) — which
--    only works if the company can name at most one card. PARTIAL so own-fleet
--    cards (carrier_company_id IS NULL, incl. the is_own_fleet cost-structure
--    card) are untouched and may still be many.
CREATE UNIQUE INDEX IF NOT EXISTS delivery_rate_cards_carrier_company_uq
  ON scm.delivery_rate_cards (company_id, carrier_company_id)
  WHERE carrier_company_id IS NOT NULL;
