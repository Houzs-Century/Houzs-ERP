-- 0032_scm_special_addons_history.sql — give the Specials / Sofa Specials
-- Maintenance tabs TRUE Edit -> Save (effective-dated) + History, matching the
-- other Maintenance pools (which version through scm.maintenance_config_history).
--
-- WHY A TABLE, NOT THE CONFIG BLOB (Option B, owner 2026-06-22):
--   Specials are the scm.special_addons TABLE, not the flat config.specials /
--   config.sofaSpecials pools. The table is structurally richer than a pool
--   entry (MfgPricedOption = { value, priceSen, sellingPriceSen }): it carries
--   option_groups (follow-up questions / 追问 with per-choice extraSen), a
--   multi-category targeting array (incl. MATTRESS), so_description and
--   sort_order. That structure is read by the POS configurator (PcVariantEditor),
--   the SO line editor (SoLineCard SpecialsAccordion), per-Model allowed_options
--   gating, every doc-detail view (PO/GRN/PI/PR/StockAdj) AND ~12 SO/consignment
--   COSTING call-sites via loadSpecialAddons -> buildSpecialsPoolFromAddons.
--   Collapsing it into the flat blob would be lossy + sprawling. So we version
--   the table instead: each Save appends a full effective-dated SNAPSHOT of the
--   whole add-on set, and applies that snapshot back onto the live table.
--
-- COSTING IS UNCHANGED: SO costing still reads the LIVE scm.special_addons table
-- via loadSpecialAddons (selling_price_sen / cost_price_sen). This history table
-- is the audit/version log + the apply-source; nothing in the recompute path
-- reads it. A Save mirrors the maintenance_config_history mechanism: append a
-- versioned snapshot row, then upsert the snapshot onto the live table (the
-- route does the upsert; this migration only creates the log).
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); RLS stripped (Houzs guards writes in the route + service-role
-- key). No unqualified enum casts, so no SET search_path needed.

CREATE TABLE IF NOT EXISTS scm.special_addons_history (
  id              text PRIMARY KEY,
  -- Full snapshot of every special_addons row at save time, as the API shape
  -- (jsonb array of { code, label, soDescription, categories, sellingPriceSen,
  -- costPriceSen, optionGroups, active, sortOrder }). One row = one version of
  -- the WHOLE set, mirroring maintenance_config_history.config.
  addons          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  effective_from  date        NOT NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid
);

COMMENT ON TABLE scm.special_addons_history IS
  'Effective-dated version log of the Specials / Sofa Specials Maintenance pools (scm.special_addons). Each row is a full snapshot (addons jsonb) at an effective_from date, mirroring maintenance_config_history. Append-only audit + apply-source for Save-with-effective-date; SO costing reads the LIVE special_addons table, never this log.';

-- History queries order by effective_from desc, then created_at desc — same as
-- the maintenance-config history/resolver. Index both.
CREATE INDEX IF NOT EXISTS special_addons_history_eff_idx
  ON scm.special_addons_history (effective_from DESC, created_at DESC);

-- Seed an initial baseline snapshot from the current live table so the History
-- view isn't empty on day one (matches the maintenance_config baseline row).
-- Idempotent: only when no snapshot exists yet.
INSERT INTO scm.special_addons_history (id, addons, effective_from, notes, created_by)
SELECT
  'sah-baseline-001',
  COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
       'code',            sa.code,
       'label',           sa.label,
       'soDescription',   sa.so_description,
       'categories',      to_jsonb(sa.categories),
       'sellingPriceSen', sa.selling_price_sen,
       'costPriceSen',    sa.cost_price_sen,
       'optionGroups',    sa.option_groups,
       'active',          sa.active,
       'sortOrder',       sa.sort_order
     ) ORDER BY sa.sort_order, sa.created_at)
     FROM scm.special_addons sa),
    '[]'::jsonb
  ),
  CURRENT_DATE,
  'Baseline snapshot (migration 0032).',
  NULL
WHERE NOT EXISTS (SELECT 1 FROM scm.special_addons_history);
