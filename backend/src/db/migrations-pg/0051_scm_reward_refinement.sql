-- _reward_refinement_DRAFT.sql — port of 2990 migration 0182 (pwp_rule_refinements).
-- Variant (size) / compartment refinement for PWP. ADDITIVE on top of the
-- existing model/combo arrays — the model/combo lists still decide WHICH
-- models/combos; these flat lists narrow the match further (mattress/bedframe by
-- size_code, an any-build sofa trigger by a contained compartment). Empty [] =
-- no refinement = legacy behavior, so every existing rule/code is unaffected.
-- The matcher is the shared scm/shared/rule-target.ts passesRefinementColumns
-- (client + server).
--
-- scm.pwp_rules: trigger + reward refinement (authored in the PWP rules editor).
-- scm.pwp_codes: the REWARD refinement is SNAPSHOTTED onto each minted code at
--                reserve/mint time, so a claim enforces it even if the rule
--                changes later (mirrors how eligible_reward_model_ids /
--                reward_combo_ids are already snapshotted). No trigger snapshot
--                on codes — the trigger refinement is enforced at mint time.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn). The parent assigns the migration number on apply.

ALTER TABLE scm.pwp_rules
  ADD COLUMN IF NOT EXISTS trigger_size_codes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS trigger_compartments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reward_size_codes    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reward_compartments  jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE scm.pwp_codes
  ADD COLUMN IF NOT EXISTS reward_size_codes   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reward_compartments jsonb NOT NULL DEFAULT '[]'::jsonb;
