-- 0027_scm_seed_maintenance_pools.sql — seed the four Products Maintenance pools
-- that shipped empty so the SCM "Products Maintenance" tabs (Bedframe Sizes /
-- Mattress Sizes / Sofa Compartments / Supplier Categories) are populated out of
-- the box.
--
-- ROOT CAUSE: these tabs read array fields off the master maintenance-config
-- JSON blob (scm.maintenance_config_history row 'mch-baseline-master-001', scope
-- 'master'), served verbatim by GET /maintenance-config/resolved?scope=master.
-- The 0022 baseline (port of 2990's 0039) carries only height/gap/specials/sofa
-- config and OMITS bedframeSizes / mattressSizes / sofaCompartments /
-- supplierCategories, so each tab's config[key].length is 0 and renders empty.
--
-- SHAPE: all four are MaintPoolEntry[] (frontend type), rendered through the
-- generic string[] branch in frontend/src/pages/scm-v2/Products.tsx (~line 3065).
-- A MaintPoolEntry is `string | { value, active? }`; a plain string IS the active
-- entry — matching the baseline's existing plain-string pools ("gaps",
-- "sofaSizes"). So all four pools are seeded as bare JSON string arrays.
--   - sofaCompartments stays a plain string[] of codes by design (PR #220):
--     per-compartment meta (image/description/price) lives in the OPTIONAL
--     parallel sofaCompartmentMeta map; the renderer does
--     `config.sofaCompartmentMeta ?? {}`, so it is NOT required for the tab to
--     render and is intentionally NOT seeded here. The 15 codes match
--     scm.compartment_library (seeded in 0022).
--   - size tabs (bedframeSizes / mattressSizes) resolve their label+dimensions
--     through resolveSizeInfo(), which falls back to the static SIZE_INFO map
--     (frontend/src/vendor/scm/lib/size-info.ts) for all 6 codes. The OPTIONAL
--     sizeLabels override map is only for commander relabels, so it is NOT
--     required for the tabs to render and is intentionally NOT seeded here.
--   - supplierCategories = the 5 DEFAULT_SUPPLIER_CATEGORIES
--     (frontend/src/vendor/scm/lib/supplier-categories.ts). The Suppliers page
--     already falls back to these when the pool is empty; seeding makes the
--     pool concrete + editable from the Maintenance tab.
--
-- IDEMPOTENCY + owner-edit safety: a single UPDATE with `seed || config` puts the
-- EXISTING config on the RIGHT of the jsonb `||` operator so any key already
-- present (incl. an owner's later edit) WINS — only keys that are ABSENT get the
-- seed value. Re-running is therefore a no-op and never clobbers commander edits.
-- The WHERE clause additionally skips the row entirely once all four keys exist,
-- so a re-run writes nothing at all.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); single statement (no internal ';\n' — the runner splits on
-- ";\n"). No unqualified enum casts, so no SET search_path needed.
UPDATE scm.maintenance_config_history
SET config = (
  $$
  {
    "bedframeSizes": ["K", "Q", "S", "SS", "SK", "SP"],
    "mattressSizes": ["K", "Q", "S", "SS"],
    "sofaCompartments": [
      "1A(LHF)", "1A(RHF)", "1B(LHF)", "1B(RHF)", "1NA",
      "2A(LHF)", "2A(RHF)", "2B(LHF)", "2B(RHF)", "2NA",
      "CNR", "L(LHF)", "L(RHF)", "Console", "STOOL"
    ],
    "supplierCategories": ["Sofa", "Bedframe", "Mattress", "Accessory", "Service"]
  }
  $$::jsonb || config
)
WHERE id = 'mch-baseline-master-001'
  AND scope = 'master'
  AND NOT (
    config ? 'bedframeSizes'
    AND config ? 'mattressSizes'
    AND config ? 'sofaCompartments'
    AND config ? 'supplierCategories'
  );
