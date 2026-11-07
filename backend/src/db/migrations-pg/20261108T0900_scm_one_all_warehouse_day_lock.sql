-- A company holds one all-warehouse lock per day. The (company_id, warehouse_id,
-- delivery_date) unique key treats NULL warehouses as distinct, so two all-warehouse
-- locks of one day could both exist. Production had no day locks when this was added.
-- REVERSAL: DROP INDEX IF EXISTS scm.delivery_day_locks_all_wh_uq;

CREATE UNIQUE INDEX IF NOT EXISTS delivery_day_locks_all_wh_uq
  ON scm.delivery_day_locks (company_id, delivery_date)
  WHERE warehouse_id IS NULL;
