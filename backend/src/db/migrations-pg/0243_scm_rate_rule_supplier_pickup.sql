-- 0243 — a rate card can finally price a SUPPLIER PICKUP.
--
-- WHY. Owner, 2026-08-02: "我的 job type 有什么类型，它就应该有什么类型... 并且
-- job type 的名字也要跟我们的 DP 那一边是一样的" — the rate card's rule types must
-- be the jobs we actually dispatch, under the same names.
--
-- Diffing the two lists showed one job you cannot charge for:
--
--   scm.trip_stop_type   DELIVERY PICKUP SERVICE SETUP DISMANTLE INSPECTION SUPPLIER_PICKUP
--   rate rule types      (tiers)  PICKUP SERVICE SETUP DISMANTLE INSPECTION      —
--
-- SUPPLIER_PICKUP has been a dispatchable DP job since 0128 put it on
-- scm.trip_stop_type, and it is one of only THREE types the New-DP-Order drawer
-- still offers (DP_CREATABLE_JOB_TYPES). Sending a lorry to collect from a
-- supplier is billable work with no way to bill it.
--
-- DISPOSE AND TRANSFER STAY, and are NOT missing job types. A dispose is an
-- add-on performed during a delivery, not a trip of its own — it is billed as a
-- line on whatever job carried it. The same reading applies to TRANSFER. Only
-- SUPPLIER_PICKUP was a genuine gap: a job you dispatch and cannot price.
--
-- NO `category` COLUMN. The Delivery / Site work / Service call / Outstation
-- grouping the UI needs is DERIVED from rule_type — a pure map in
-- scm/lib/rate-rule-taxonomy.ts. Storing it would be a second source of truth
-- for something a rule type already determines, and the first time the two
-- disagreed the money would follow the wrong one.
--
-- The CHECK from 0207 is an inline column constraint; drop and re-add, exactly
-- as 0212 did when it added OUTSTATION_TRIP.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT
-- MERGE — 0243 was next free above 0242.

SET search_path = scm, public;

ALTER TABLE scm.delivery_rate_rules
  DROP CONSTRAINT IF EXISTS delivery_rate_rules_rule_type_check;

ALTER TABLE scm.delivery_rate_rules
  ADD CONSTRAINT delivery_rate_rules_rule_type_check
  CHECK (rule_type IN (
    'POSITIONAL_TIER', 'OVERAGE', 'SOFA_BRACKET', 'OUTSTATION', 'OUTSTATION_TRIP',
    'DISPOSE', 'SETUP', 'DISMANTLE',
    'SERVICE', 'PICKUP', 'INSPECTION', 'TRANSFER', 'SUPPLIER_PICKUP'));
