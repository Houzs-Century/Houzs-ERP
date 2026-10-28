-- 0212_scm_rate_rule_outstation_trip.sql — WS4c: fixed per-TRIP outstation fee.
--
-- WHY. Owner: the outstation charge has TWO layers — a per-ORDER surcharge (the
-- existing OUTSTATION rule) AND a FIXED fee per TRIP by destination zone (once
-- per trip regardless of drop count). This adds a new rule_type OUTSTATION_TRIP
-- so a card can carry both. The trip fee is applied once per trip in the reconcile
-- (outside the per-drop computeDeliveryCost); OUTSTATION stays the per-order layer.
--
-- The rule_type CHECK in mig 0207 is an inline column constraint (auto-named
-- <table>_<column>_check). Drop + re-add it with OUTSTATION_TRIP included.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK NUMBER AT MERGE.

SET search_path = scm, public;

ALTER TABLE scm.delivery_rate_rules
  DROP CONSTRAINT IF EXISTS delivery_rate_rules_rule_type_check;

ALTER TABLE scm.delivery_rate_rules
  ADD CONSTRAINT delivery_rate_rules_rule_type_check
  CHECK (rule_type IN (
    'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET', 'OUTSTATION', 'OUTSTATION_TRIP',
    'DISPOSE', 'SETUP', 'DISMANTLE',
    'SERVICE', 'PICKUP', 'INSPECTION', 'TRANSFER'));
