-- 0118_scm_do_item_rack.sql — add the per-line SOURCE RACK column to
-- scm.delivery_order_items so a DO line can record which physical rack its
-- goods leave from on dispatch (REC P4: rack stock-out on GR-in / DO-out, no
-- camera scan). Mirrors scm.grn_items.rack_id (the DESTINATION rack chosen on a
-- GRN line). When set, the dispatch chokepoint (deductInventoryForDo →
-- stockOutDoLinesFromRacks) pulls the stock-out from THIS rack; when null it
-- auto-picks the rack(s) that hold the product in the ship-from warehouse.
--
-- Houzs SCM port conventions (mirrors 0090 / 0111): the scm.* tables live in the
-- separate `scm` postgres schema, so this is schema-qualified. Plain
-- `ADD COLUMN IF NOT EXISTS` (NOT a DO block) — the pg-migrate runner splits
-- each file on ";\n", which would fragment a dollar-quoted block; ADD COLUMN
-- IF NOT EXISTS is already idempotent + re-run-safe, so the auto-apply on every
-- deploy is a no-op after the first. scm.delivery_order_items exists on prod
-- (core SCM table), so this only ever adds one nullable column.
ALTER TABLE scm.delivery_order_items ADD COLUMN IF NOT EXISTS rack_id uuid;

-- Index the new FK-style column so the dispatch-time lookups + any rack-scoped
-- reporting stay index-backed as DO volume grows (matches 0111's hot-column
-- indexing). Partial (WHERE rack_id IS NOT NULL) — the vast majority of legacy
-- lines carry no explicit rack pick.
CREATE INDEX IF NOT EXISTS idx_scm_do_items_rack_id ON scm.delivery_order_items (rack_id) WHERE rack_id IS NOT NULL;
