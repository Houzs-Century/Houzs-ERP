-- 0024_scm_special_delivery_fee_rules.sql — port of 2990 migration 0183.
-- Generalises scm.model_special_delivery_fees (the per-Model 0140 table) onto the
-- #691 RuleTarget abstraction. A rule's `target` jsonb is RuleTarget[] (scopes
-- model | variant | compartment | combo). standalone_fee OVERRIDES the base
-- delivery fee (scm.delivery_fee_config.base_fee) when the rule matches an SO;
-- cross_cat_followup_fee applies when the matched SO is a cross-category
-- follow-up linked to an earlier SO. Fees are whole MYR (the server scales ×100
-- to sen at order time), mirroring 0140.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); RLS / is_staff() stripped (Houzs guards writes in the route +
-- service-role key). Houzs currently has 0 rows in model_special_delivery_fees,
-- so the data backfill below is a no-op, but kept for parity with 2990.
CREATE TABLE IF NOT EXISTS scm.special_delivery_fee_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  standalone_fee          integer NOT NULL DEFAULT 0 CHECK (standalone_fee         >= 0),
  cross_cat_followup_fee  integer NOT NULL DEFAULT 0 CHECK (cross_cat_followup_fee >= 0),
  label                   text,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid
);

COMMENT ON TABLE scm.special_delivery_fee_rules IS 'Special transport-fee rules keyed on the #691 RuleTarget abstraction (target jsonb = RuleTarget[]). standalone_fee overrides the base delivery fee; cross_cat_followup_fee applies on a cross-category follow-up SO. Fees are whole MYR (server scales x100 to sen). Generalises scm.model_special_delivery_fees (0140). Migration 0024 (ports 2990 0183).';

-- Data move: each existing per-Model tag becomes one rule targeting that Model
-- (scope='model'). Guarded so a re-run seeds only once (idempotent on this
-- migration runner). Houzs has 0 model_special_delivery_fees rows today → no-op.
INSERT INTO scm.special_delivery_fee_rules (target, standalone_fee, cross_cat_followup_fee, updated_at, updated_by)
SELECT jsonb_build_array(jsonb_build_object('modelId', model_id::text, 'scope', 'model')), standalone_fee, cross_cat_followup_fee, updated_at, updated_by
FROM scm.model_special_delivery_fees
WHERE NOT EXISTS (SELECT 1 FROM scm.special_delivery_fee_rules);
