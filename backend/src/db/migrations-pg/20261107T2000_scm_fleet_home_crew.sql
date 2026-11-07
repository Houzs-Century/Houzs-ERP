-- Coverage & Fleet (owner 2026-11-07): a lorry names the driver and helper usually on it,
-- and a driver or helper names the warehouse they work from. A lorry's home warehouse
-- stays lorries.warehouse_id, now chosen on its own instead of the first ticked.
-- REVERSAL: ALTER TABLE scm.lorries DROP COLUMN IF EXISTS usual_driver_id, DROP COLUMN IF EXISTS usual_helper_id; ALTER TABLE scm.drivers DROP COLUMN IF EXISTS warehouse_id; ALTER TABLE scm.helpers DROP COLUMN IF EXISTS warehouse_id;

ALTER TABLE scm.lorries ADD COLUMN IF NOT EXISTS usual_driver_id uuid REFERENCES scm.drivers(id) ON DELETE SET NULL;
ALTER TABLE scm.lorries ADD COLUMN IF NOT EXISTS usual_helper_id uuid REFERENCES scm.helpers(id) ON DELETE SET NULL;
ALTER TABLE scm.drivers ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES scm.warehouses(id) ON DELETE SET NULL;
ALTER TABLE scm.helpers ADD COLUMN IF NOT EXISTS warehouse_id uuid REFERENCES scm.warehouses(id) ON DELETE SET NULL;

COMMENT ON COLUMN scm.lorries.usual_driver_id IS 'The driver usually on this lorry. A default for crewing a run; each trip still records its own crew.';
COMMENT ON COLUMN scm.lorries.usual_helper_id IS 'The helper usually on this lorry. A default only, like usual_driver_id.';
COMMENT ON COLUMN scm.drivers.warehouse_id IS 'The warehouse this driver works from. Null = not set.';
COMMENT ON COLUMN scm.helpers.warehouse_id IS 'The warehouse this helper works from. Null = not set.';
