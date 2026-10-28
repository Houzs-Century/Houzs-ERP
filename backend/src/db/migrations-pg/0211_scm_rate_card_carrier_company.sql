-- 0211_scm_rate_card_carrier_company.sql — WS4b: rate card priced PER 3PL COMPANY.
--
-- WHY. Owner: a 3PL's lorries all charge the same, so the delivery rate card
-- belongs to the COMPANY, not each individual lorry. mig 0207 keyed a card by
-- carrier_lorry_id (one lorry); WS4a (0210) added scm.threepl_companies + the
-- lorry->company link. This adds carrier_company_id so a card is set once per
-- company and applies to every lorry under it.
--
-- Additive + back-compat: carrier_lorry_id / carrier_label stay (own-fleet cards
-- and any legacy per-lorry 3PL card keep working). The reconciliation resolves a
-- trip's lorry -> its threepl_company_id -> the company card, falling back to the
-- per-lorry card. min_charge_centi is untouched here (owner dropped it from the
-- FORM in the frontend; the column stays nullable so historical rows are intact).
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK NUMBER AT MERGE.

SET search_path = scm, public;

ALTER TABLE scm.delivery_rate_cards
  ADD COLUMN IF NOT EXISTS carrier_company_id UUID NULL
    REFERENCES scm.threepl_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_delivery_rate_cards_carrier_company
  ON scm.delivery_rate_cards (company_id, carrier_company_id);
