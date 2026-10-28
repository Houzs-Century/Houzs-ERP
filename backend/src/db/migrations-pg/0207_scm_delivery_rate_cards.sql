-- 0207_scm_delivery_rate_cards.sql — Fleet Module C: 3PL / own-fleet delivery
-- RATE CARDS + the per-rule rows a card is built from.
--
-- WHY. When a 3PL bills Houzs for a delivery run, ops verifies that charge by
-- hand against a price list today. Module C makes the price list a CONFIGURED
-- object — a rate card per carrier — so the billed amount can be checked
-- instantly against a COMPUTED expected cost, and the precise delivery cost can
-- be rolled into COGS for margin. Own-fleet also gets a card (built from its own
-- cost structure) so a 3PL drop and an own-fleet drop are comparable per drop.
--
-- This is delivery-COST verification + COGS ATTRIBUTION. It is NOT customer
-- billing, and it does NOT touch the FIFO lot / consumption money-path triggers.
-- The computed delivery cost is an ATTACHED cost reported alongside, per the
-- money-engine's separation of concerns.
--
-- TWO additive tables, one file (repo rule: one migration per slice):
--   1. scm.delivery_rate_cards — one card per carrier. A carrier is an existing
--      scm.lorries row (an OUTSOURCE lorry / is_internal=false 3PL, or an
--      in-house lorry for the own-fleet card) referenced by carrier_lorry_id,
--      OR a free-text carrier_label when the 3PL is not modelled as a lorry.
--      Carries the card-level dimensions: charging BASIS (item | set),
--      AGGREGATION unit (drop | customer), and optional min-charge / cap /
--      rounding envelope.
--   2. scm.delivery_rate_rules — the priced rules a card is built from, one row
--      per rule. rule_type selects the dimension (positional tier, cap overage,
--      sofa compartment bracket, outstation zone surcharge, dispose, setup,
--      dismantle, service, pickup, inspection, transfer); tier_position /
--      bracket_min / bracket_max / zone position the rule within its dimension;
--      amount_centi is the price (integer sen). The pure computeDeliveryCost
--      (backend/src/scm/lib/delivery-rate-card.ts) reads these rows.
--
-- MULTI-COMPANY. Scoped per company like the other scm masters: company_id
-- BIGINT NOT NULL REFERENCES public.companies(id). A card name is UNIQUE per
-- (company_id, name).
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, no
-- runtime self-apply. All money integer sen (*_centi). pg-migrate runs the whole
-- file in one transaction.
-- RE-CHECK NUMBER AT MERGE — 0207 was the next free number above 0206 at branch
-- time (0200/0201 were reserved by sibling branches).

SET search_path = scm, public;

-- ── 1. Rate card (per carrier) ──────────────────────────────────────────────
-- One card per carrier. basis / aggregation are the two card-level dimensions
-- the owner names first; the min/cap/rounding envelope is optional. A card with
-- is_active=false is kept for history but excluded from carrier auto-match.
CREATE TABLE IF NOT EXISTS scm.delivery_rate_cards (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        BIGINT NOT NULL REFERENCES public.companies(id),
  name              TEXT NOT NULL,
  -- The carrier this card prices. Either an existing lorry (3PL OUTSOURCE or an
  -- in-house lorry for the own-fleet card) OR a free-text label when the 3PL is
  -- not modelled as a lorry. At least one is expected; both may be set (the
  -- label is then a display alias for the lorry).
  carrier_lorry_id  UUID NULL REFERENCES scm.lorries(id) ON DELETE SET NULL,
  carrier_label     TEXT NULL,
  -- TRUE => the own-fleet card (cost structure, not a 3PL price list). Lets the
  -- reconciliation view label own-fleet vs 3PL and keep the per-drop compare.
  is_own_fleet      BOOLEAN NOT NULL DEFAULT false,
  -- Charging basis: price by ITEM or by SET (set = frame + mattress).
  basis             TEXT NOT NULL DEFAULT 'SET'
                      CHECK (basis IN ('ITEM', 'SET')),
  -- Aggregation unit the positional tiers count over: per DROP point or per
  -- CUSTOMER.
  aggregation       TEXT NOT NULL DEFAULT 'DROP'
                      CHECK (aggregation IN ('DROP', 'CUSTOMER')),
  -- Optional envelope applied to the summed cost.
  min_charge_centi  BIGINT NULL CHECK (min_charge_centi IS NULL OR min_charge_centi >= 0),
  cap_centi         BIGINT NULL CHECK (cap_centi IS NULL OR cap_centi >= 0),
  rounding          TEXT NOT NULL DEFAULT 'NONE'
                      CHECK (rounding IN ('NONE', 'NEAREST_10C', 'NEAREST_RM')),
  is_active         BOOLEAN NOT NULL DEFAULT true,
  notes             TEXT NULL,
  created_by        UUID NULL,
  updated_by        UUID NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_rate_cards_name_uq UNIQUE (company_id, name)
);

-- Carrier auto-match (reconciliation joins a 3PL trip's lorry to its card).
CREATE INDEX IF NOT EXISTS idx_delivery_rate_cards_carrier
  ON scm.delivery_rate_cards (company_id, carrier_lorry_id);

-- ── 2. Rate rules (the priced rows a card is built from) ────────────────────
-- One row per priced rule. The pure calculator interprets each rule_type:
--   POSITIONAL_TIER  tier_position = 1 | 2 | 3 (3 = "3rd and beyond"); price of
--                    the Nth charging unit (set/item) at a drop.
--   OVERAGE          tier_position = the cap N (max units/drop); amount_centi is
--                    charged for EACH unit beyond N (caps the tier ladder).
--   SOFA_BRACKET     bracket_min..bracket_max = sofa compartment count band
--                    (bracket_max NULL = open-ended "N+"); one bracket per sofa.
--   OUTSTATION       zone = destination area zone (reuse the A1 classifier);
--                    amount_centi is the outstation surcharge for that zone.
--   DISPOSE          per item/set (amount_centi x dispose count) or flat (x1).
--   SETUP / DISMANTLE  each per occurrence (amount_centi x count).
--   SERVICE / PICKUP / INSPECTION / TRANSFER  the owner's order-type charges,
--                    own rate each (amount_centi x count).
-- params JSONB is an escape hatch for a rule that needs an extra knob later; the
-- calculator ignores unknown keys, so adding one is additive.
CREATE TABLE IF NOT EXISTS scm.delivery_rate_rules (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     BIGINT NOT NULL REFERENCES public.companies(id),
  card_id        UUID NOT NULL REFERENCES scm.delivery_rate_cards(id) ON DELETE CASCADE,
  rule_type      TEXT NOT NULL CHECK (rule_type IN (
                   'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET', 'OUTSTATION',
                   'DISPOSE', 'SETUP', 'DISMANTLE',
                   'SERVICE', 'PICKUP', 'INSPECTION', 'TRANSFER')),
  tier_position  SMALLINT NULL CHECK (tier_position IS NULL OR tier_position >= 1),
  bracket_min    SMALLINT NULL CHECK (bracket_min IS NULL OR bracket_min >= 0),
  bracket_max    SMALLINT NULL CHECK (bracket_max IS NULL OR bracket_max >= 0),
  zone           TEXT NULL,
  amount_centi   BIGINT NOT NULL CHECK (amount_centi >= 0),
  params         JSONB NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_rate_rules_bracket_ck
    CHECK (bracket_min IS NULL OR bracket_max IS NULL OR bracket_min <= bracket_max)
);

-- Rules are always loaded per card, ordered for a stable display.
CREATE INDEX IF NOT EXISTS idx_delivery_rate_rules_card
  ON scm.delivery_rate_rules (company_id, card_id, rule_type, sort_order);
