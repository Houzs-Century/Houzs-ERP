-- 0209_scm_lorry_box_dimensions.sql — WS3: per-lorry cargo-box dimensions.
--
-- WHY. Owner (from HookkaERP): record a lorry's box Length x Width x Height (ft)
-- and auto-compute its Maximum capacity in m3. scm.lorries already has a
-- capacity_m3 column (mig 0053) — today it is entered by hand on the New Lorry
-- form. This adds the three dimension columns so capacity_m3 can be DERIVED from
-- L x W x H (ft) x 0.0283168 (ft3 -> m3) whenever the dimensions are set. The
-- derivation lives in the route (lorries.ts PATCH/POST); this migration only adds
-- the storage.
--
-- Region gating is NOT here — scm.lorries.warehouse_id (the region link) already
-- exists (mig 0053); WS3 only makes it editable in the drawer and gates the
-- pickers on it.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, one
-- transaction. RE-CHECK THE NUMBER AT MERGE — 0209 was the next free number above
-- 0208 at branch time.

SET search_path = scm, public;

ALTER TABLE scm.lorries
  ADD COLUMN IF NOT EXISTS length_ft NUMERIC(6,2) NULL CHECK (length_ft IS NULL OR length_ft >= 0),
  ADD COLUMN IF NOT EXISTS width_ft  NUMERIC(6,2) NULL CHECK (width_ft  IS NULL OR width_ft  >= 0),
  ADD COLUMN IF NOT EXISTS height_ft NUMERIC(6,2) NULL CHECK (height_ft IS NULL OR height_ft >= 0);
