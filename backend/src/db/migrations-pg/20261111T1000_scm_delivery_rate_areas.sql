-- 20261111T1000_scm_delivery_rate_areas.sql
--
-- WHY. Owner 2026-11-11, on the carriers' quotations: a carrier prices each AREA
-- with its own ladder — for each group of towns, a price for the first sets, a
-- price for each item after, a price per sofa — not the city ladder plus one flat
-- surcharge. The card could only add a per-town surcharge, so an outstation
-- delivery with a third set or a sofa was priced at the city's extra-item and
-- sofa prices, well under what the quotation charges there. Owner: 「做」.
--
-- An AREA belongs to one card: a name and the towns it covers (matched as whole
-- words in the delivery address, as a town outstation rule already is). A rule
-- may name an area; a delivery in that area prices each rule type the area
-- carries with the area's rules, and every other type with the card's own
-- (scm/lib/delivery-rate-card.ts). A rule with no area is the card's, as before,
-- so every existing card prices exactly as it did until an area is added.
--
-- MULTI-COMPANY. company_id on every row, as on scm.delivery_rate_rules; the
-- route scopes reads and writes to the active company. Natural key (card_id, name).
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill. RE-CHECK THE
-- NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.delivery_rate_rules DROP COLUMN IF EXISTS area_id;
--   DROP TABLE IF EXISTS scm.delivery_rate_areas;

CREATE TABLE IF NOT EXISTS scm.delivery_rate_areas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  BIGINT NOT NULL REFERENCES public.companies(id),
  card_id     UUID NOT NULL REFERENCES scm.delivery_rate_cards(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  towns       TEXT[] NOT NULL DEFAULT '{}',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_rate_areas_name_uq UNIQUE (card_id, name)
);

CREATE INDEX IF NOT EXISTS idx_delivery_rate_areas_card
  ON scm.delivery_rate_areas (card_id);

-- Like every scm table (mig 0061): RLS on with no policy, so only the service
-- role the Worker uses reads or writes it.
ALTER TABLE scm.delivery_rate_areas ENABLE ROW LEVEL SECURITY;

-- A rule's area. NULL = the card's own rule (every rule written before this
-- migration). Removing an area removes its rules with it.
ALTER TABLE scm.delivery_rate_rules
  ADD COLUMN IF NOT EXISTS area_id UUID NULL REFERENCES scm.delivery_rate_areas(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_delivery_rate_rules_area
  ON scm.delivery_rate_rules (area_id) WHERE area_id IS NOT NULL;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role, like the
-- rate cards and their rules.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.delivery_rate_areas TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.delivery_rate_areas IS
  'A rate card''s priced areas: a name and the towns it covers; rules naming the area price deliveries there '
  'in place of the card''s own rules of the same type. See scm/lib/delivery-rate-card.ts.';

-- Let PostgREST see the new table and column without a manual reload.
NOTIFY pgrst, 'reload schema';
