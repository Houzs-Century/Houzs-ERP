-- 20261124T2230_scm_rate_rule_do_charge.sql
--
-- WHY. Owner 2026-11-24, on the two Singapore carriers (EU LOGISTICS and Hao
-- Hua Furniture): 「EU Logistics 和 hao hua 的算法应该就是Singapore transport的算法」,
-- 「based on good」. Their bills charge shares of the goods value (an SST share
-- and a cost share), and Hao Hua adds a fixed permit per order; no rate card
-- rule could say either. DO_CHARGE is a named charge on each delivery order: a
-- fixed amount (amount_sen, sen per DO) and/or a share of the DO's goods value
-- (params.bps, basis points; params.label its name). The calculator is
-- scm/lib/delivery-rate-card.ts; the list of rule types is
-- scm/lib/rate-rule-taxonomy.ts (held to this CHECK by audit:job-types).
--
-- The CHECK is re-made with one value more, exactly as 0243 did for
-- SUPPLIER_PICKUP. Additive, idempotent, schema-qualified, no data.
-- RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DELETE FROM scm.delivery_rate_rules WHERE rule_type = 'DO_CHARGE';
--   then re-add the CHECK without 'DO_CHARGE' (the list in 0243). Revert the
--   code first. The delete removes the per-DO charges typed on rate cards; the
--   cards are a price list only, nothing posts from them. GRANTS: none.

SET search_path = scm, public;

ALTER TABLE scm.delivery_rate_rules
  DROP CONSTRAINT IF EXISTS delivery_rate_rules_rule_type_check;

ALTER TABLE scm.delivery_rate_rules
  ADD CONSTRAINT delivery_rate_rules_rule_type_check
  CHECK (rule_type IN (
    'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET', 'OUTSTATION', 'OUTSTATION_TRIP',
    'DISPOSE', 'SETUP', 'DISMANTLE',
    'SERVICE', 'PICKUP', 'INSPECTION', 'TRANSFER', 'SUPPLIER_PICKUP',
    'DO_CHARGE'));
