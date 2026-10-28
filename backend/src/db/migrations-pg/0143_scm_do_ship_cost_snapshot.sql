-- 0143_scm_do_ship_cost_snapshot.sql
-- Freeze the DO ship-time FIFO cost so the Finance > Fulfillment Costing report
-- can show a PERMANENT three-way split: ① order-time cost, ② DO ship-time FIFO
-- cost, ③ SI landed store-card cost.
--
-- THE GAP THIS CLOSES: restampDoActualCost overwrites
-- scm.delivery_order_items.unit_cost_centi IN PLACE, and lib/recost.ts re-runs
-- it when a supplier PI lands — so after the PI, the DO line's unit_cost_centi
-- has become the landed cost and ② == ③. The ship-time FIFO value (②) is lost.
-- ship_cost_centi is the snapshot that survives the recost: the write path
-- (freezeShipCost) sets it ONCE at first post-ship costing and never overwrites
-- it, so recost changes unit_cost_centi (③) but leaves ship_cost_centi (②).
--
-- UNIT semantics, mirroring unit_cost_centi (a per-piece cost in cents). One
-- nullable column keeps this minimal; line cost is unit*qty, derived by readers.
--
-- SAFE TO AUTO-APPLY ON DEPLOY:
--   * ADD COLUMN IF NOT EXISTS — idempotent, a no-op after the first apply.
--   * NULLABLE, no DEFAULT, NO backfill — nothing to fail on existing rows.
--   * scm.delivery_order_items is a core SCM table present on prod (mirrors
--     0118_scm_do_item_rack, which added a column the same way).
--   * Plain statement, not a DO/dollar-quoted block — the pg-migrate runner
--     splits each file on ";\n" and would fragment a dollar-quoted body.
--
-- BACKFILL REALITY (honest, not faked): DOs already shipped-and-recosted before
-- this migration have lost their ship-time ② for good — ship_cost_centi stays
-- NULL for them and the report falls back to unit_cost_centi and LABELS the row
-- as legacy (②≈③ is a legacy limitation, not real convergence). Only DOs
-- shipped from this deploy onward carry the true frozen ②.

SET search_path = public, scm;

ALTER TABLE scm.delivery_order_items ADD COLUMN IF NOT EXISTS ship_cost_centi bigint;

COMMENT ON COLUMN scm.delivery_order_items.ship_cost_centi IS
  'Frozen ship-time FIFO actual UNIT cost (cents), captured once at first '
  'post-ship costing and never overwritten by a later PI recost. NULL on DOs '
  'shipped before mig 0143. Powers the Finance Fulfillment Costing three-way '
  'comparison (② DO ship-time vs ③ SI landed).';
