-- 0186 — Keep scm.warehouses.is_showroom in lockstep with the type enum.
--
-- WHY. mig 0177 introduced the `type` enum (warehouse / showroom / display /
-- service / others) and did a ONE-TIME, ONE-DIRECTION backfill: is_showroom=true
-- -> type='showroom'. It added NO trigger, and the warehouse write UI
-- (WarehouseFormDrawer) sets `type` but never touches the legacy `is_showroom`
-- boolean. So a warehouse typed 'showroom' through the new UI keeps
-- is_showroom=false — exactly what happened to 2990's "PJ SHOWROOM": it never
-- appeared in the sales-venue picker (staff.ts GET /showrooms filters
-- is_showroom=true), the venue-binding resolver (mig 0148), or the showroom
-- inventory view (inventory.ts). is_showroom is read in 28 sites across 5 files,
-- so syncing the flag FROM type fixes every reader at once.
--
-- type is the canonical field post-0177; is_showroom is derived from it.

-- 1. One-time reconcile: is_showroom must equal (type = 'showroom').
UPDATE scm.warehouses
   SET is_showroom = (type = 'showroom')
 WHERE is_showroom IS DISTINCT FROM (type = 'showroom');

-- 2. Enforce the invariant on every future write, regardless of code path, so
--    is_showroom can never drift from type again. COALESCE guards a NULL type
--    (is_showroom is NOT NULL) -> a typeless row is not a showroom.
CREATE OR REPLACE FUNCTION scm.warehouse_sync_is_showroom() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_showroom := COALESCE(NEW.type = 'showroom', false);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_warehouse_sync_is_showroom ON scm.warehouses;
CREATE TRIGGER trg_warehouse_sync_is_showroom
  BEFORE INSERT OR UPDATE OF type, is_showroom ON scm.warehouses
  FOR EACH ROW EXECUTE FUNCTION scm.warehouse_sync_is_showroom();
