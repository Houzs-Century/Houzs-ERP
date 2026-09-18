-- 20260911T1530_scm_warehouse_rack_zone.sql
--
-- REVERSAL: ALTER TABLE scm.warehouse_racks DROP COLUMN zone;
--   (drops every manual zone assignment; the floor plan then falls back to the
--   number-range rule for all racks, which is the pre-column behaviour.)
--
-- WHAT THIS IS. The Warehouse "Rack Overview" floor plan groups racks into
-- ZONE A / ZONE B by rack NUMBER (L1-8/R1-8 -> A, L9-21/R9-17 -> B). The owner
-- asked to override that per rack — "需要加 button 选择 rack 可以放进 zone A 还是
-- zone B" — so a rack can sit in a zone its number would not put it in.
--
-- `zone` holds that manual choice: the zone LABEL ("ZONE A" / "ZONE B") or NULL
-- for "follow the number rule". It is nullable and defaults NULL, so every
-- existing rack keeps its derived zone until someone sets one. Exact-match only
-- (the UI sends a fixed label), so no trigram index is needed. The column lives
-- on each slot row; the UI sets every level of a rack together, so both levels
-- resolve to the same zone.

ALTER TABLE scm.warehouse_racks ADD COLUMN zone text;

COMMENT ON COLUMN scm.warehouse_racks.zone IS
  'Manual floor-plan zone override (e.g. "ZONE A"); NULL = derive the zone from '
  'the rack number (WAREHOUSE_ZONES in frontend warehouse-floorplan.ts).';
