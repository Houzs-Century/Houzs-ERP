-- 20261111T1100_scm_delivery_places.sql
--
-- WHY. Owner 2026-11-11: the carriers' rate cards must use the same areas as
-- the Delivery Zones maintenance. A rate card found a town by spotting its name
-- anywhere in the delivery address, so a Kuala Lumpur address on Jalan Ipoh was
-- priced as Ipoh. Owner: 「做」.
--
-- A PLACE is a town under a delivery zone: its name as a rate card prices it
-- and the zone its postcodes fall in (scm.delivery_zone_postcodes decides an
-- order's zone from its postcode). The rate card calculator now reads a town a
-- card prices only inside that town's zone (scm/lib/delivery-rate-card.ts). A
-- NULL zone is a place in no zone (abroad): read by its name alone.
--
-- MULTI-COMPANY. company_id on every row, as on scm.delivery_zone_postcodes; the
-- route scopes reads and writes to the active company. Natural key
-- (company_id, name); names are stored upper case.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill (places are
-- added on the Delivery Zones page). RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.delivery_places;

CREATE TABLE IF NOT EXISTS scm.delivery_places (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  BIGINT NOT NULL REFERENCES public.companies(id),
  name        TEXT NOT NULL,
  zone        TEXT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_places_name_uq UNIQUE (company_id, name),
  CONSTRAINT delivery_places_name_upper CHECK (name <> '' AND name = upper(name))
);

CREATE INDEX IF NOT EXISTS idx_delivery_places_company_zone
  ON scm.delivery_places (company_id, zone);

-- Like every scm table (mig 0061): RLS on with no policy, so only the service
-- role the Worker uses reads or writes it.
ALTER TABLE scm.delivery_places ENABLE ROW LEVEL SECURITY;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role, like the
-- zone map and the rate cards.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.delivery_places TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.delivery_places IS
  'Towns under the delivery zones: the name a rate card prices and the zone its postcodes fall in (NULL = no zone). '
  'The rate card calculator reads a town only inside its zone. See scm/lib/delivery-rate-card.ts.';

-- Let PostgREST see the new table without a manual reload.
NOTIFY pgrst, 'reload schema';
