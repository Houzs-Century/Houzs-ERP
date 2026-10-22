-- Owner, 2026-10-16: one lorry can serve several warehouses. warehouse_ids is
-- that set (empty = any warehouse); warehouse_id stays as its first entry for
-- readers that only know one. Backfilled from warehouse_id.
-- REVERSAL: ALTER TABLE scm.lorries DROP COLUMN IF EXISTS warehouse_ids;
ALTER TABLE scm.lorries ADD COLUMN IF NOT EXISTS warehouse_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE scm.lorries SET warehouse_ids = ARRAY[warehouse_id]
 WHERE warehouse_id IS NOT NULL AND cardinality(warehouse_ids) = 0;
