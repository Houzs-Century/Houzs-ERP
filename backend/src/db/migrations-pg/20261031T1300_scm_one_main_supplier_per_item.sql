-- 20261031T1300_scm_one_main_supplier_per_item.sql
-- REVERSAL: DROP INDEX IF EXISTS scm.supplier_bindings_one_main_per_item;
--   GRANTS: none touched — one index.
--
-- One main supplier per item (owner 2026-10-31: "main supplier 只可以放一个").
-- The single create and the edit already demote the old main; the batch bind
-- did not, and left 83 items with two or three mains (fixed in the route and
-- cleared on production by repair-sofa-main-supplier.mjs,
-- repair-main-supplier-latest-po.mjs and set-main-supplier-owner-picks.mjs).
-- This index makes a second main a refused write from any path.
--
-- Safe to run: on 2026-10-31, after those scripts, no company has an item with
-- more than one main (each script's fresh-connection re-read). If one appears
-- before this applies, the CREATE fails and names the duplicate; clear it
-- rather than weakening the index.
CREATE UNIQUE INDEX IF NOT EXISTS supplier_bindings_one_main_per_item
  ON scm.supplier_material_bindings (company_id, material_kind, item_code)
  WHERE is_main_supplier;
