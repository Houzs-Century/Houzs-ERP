-- 20261015T1500_scm_lorry_cost_per_km.sql
-- REVERSAL: ALTER TABLE scm.lorries DROP COLUMN IF EXISTS cost_per_km_sen;
--
-- WHAT THIS CHANGES: one nullable column on scm.lorries; no row is written.
--
-- WHY: own lorries had no running cost in the TMS (3PL trips are costed by rate
-- card). Cost of a lorry's day = km driven (from scm.lorry_positions, the
-- Velocity fixes) x this rate. NULL = rate not set yet; staff fill it on the
-- lorry page. No figure is assumed here.

ALTER TABLE scm.lorries
  ADD COLUMN IF NOT EXISTS cost_per_km_sen integer CHECK (cost_per_km_sen >= 0);
