-- 20261015T1500_scm_lorry_cost_per_km.sql
-- REVERSAL: ALTER TABLE scm.lorries DROP COLUMN IF EXISTS cost_per_km_sen;
--           DROP INDEX IF EXISTS scm.lorry_positions_recorded_at_idx;
--
-- WHAT THIS CHANGES: one nullable column on scm.lorries and one index on
-- scm.lorry_positions (a small table, started 15 Oct); no row is written.
--
-- WHY: own lorries had no running cost in the TMS (3PL trips are costed by rate
-- card). Cost of a lorry's day = km driven (from scm.lorry_positions, the
-- Velocity fixes) x this rate. NULL = rate not set yet; staff fill it on the
-- lorry page. No figure is assumed here.

ALTER TABLE scm.lorries
  ADD COLUMN IF NOT EXISTS cost_per_km_sen integer CHECK (cost_per_km_sen >= 0);

-- GET /lorries/km-cost reads one day across all lorries; the (lorry_id,
-- recorded_at) unique index cannot serve a time-only range.
CREATE INDEX IF NOT EXISTS lorry_positions_recorded_at_idx ON scm.lorry_positions (recorded_at);
