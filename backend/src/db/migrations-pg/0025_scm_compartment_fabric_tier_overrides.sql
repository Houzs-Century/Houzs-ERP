-- 0025_scm_compartment_fabric_tier_overrides.sql — port of 2990 migration 0184.
-- Per-compartment sofa fabric-tier Δ overrides. Sibling of
-- scm.model_fabric_tier_overrides (0172). The effective whole-sofa Δ per tier is
-- the MAX over the SET special values (the Model override + every override whose
-- compartment code is in the build's cells), resolved server-side; NULL tier =
-- inherit the global fabric_tier_addon_config, 0 = free.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); RLS / is_staff() stripped (writes guarded in the route).
CREATE TABLE IF NOT EXISTS scm.compartment_fabric_tier_overrides (
  compartment_id  text PRIMARY KEY REFERENCES scm.compartment_library(id) ON DELETE CASCADE,
  tier2_delta     integer,
  tier3_delta     integer,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

COMMENT ON TABLE scm.compartment_fabric_tier_overrides IS 'Per-compartment selling fabric-tier delta override (whole MYR). NULL tier = inherit fabric_tier_addon_config. Effective whole-sofa delta = MAX(model override, matching compartment overrides) per tier. Migration 0025 (ports 2990 0184).';
