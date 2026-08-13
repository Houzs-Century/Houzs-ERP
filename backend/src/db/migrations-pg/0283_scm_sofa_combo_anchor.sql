-- 0283_scm_sofa_combo_anchor.sql
--
-- The one table R8 (the sofa combo anchor mirror) came across from 2990 without.
--
-- Owner decision 2026-08-12: complete the feature. Everything else already
-- exists and has since it was vendored - the route (GET /anchors, PUT
-- /anchors/:baseModel, loadComboAnchor, mirrorAnchoredCombo in
-- scm/routes/sofa-combos.ts), the query hooks (useSofaComboAnchors,
-- useSetSofaComboAnchor) and the UI control itself
-- (vendor/scm/components/SofaComboTab.tsx:245-253). Only the table was missing,
-- which is why GET /anchors returned 500 on every Combo Pricing page load until
-- 2026-08-12 (see BUG-HISTORY and docs/modules/combo-pricing.md section 6).
--
-- WHAT AN ANCHOR IS. It pins one base_model to ONE supplier. While anchored,
-- every combo CREATE and price EDIT is mirrored bidirectionally between the
-- master row (supplier_id NULL, the sales-side reference) and that supplier's
-- row, so the Product-Maintenance cost reference and the anchored supplier's
-- cost stay in lock-step and the same number is never typed twice.
--
-- CREATING THIS TABLE CHANGES NOTHING ON ITS OWN. An empty table means no model
-- is anchored, mirrorAnchoredCombo is never reached, and every combo write
-- behaves exactly as it does today. Behaviour changes only when a human sets an
-- anchor in the UI, which is a deliberate act. That is why this is safe to apply
-- to a live business carrying 270 combo rows (173 of them supplier-scoped).
--
-- THE UNIQUE KEY IS LOAD-BEARING AND MUST STAY (company_id, base_model).
-- sofa-combos.ts:452 upserts with onConflict: 'company_id,base_model'. Postgres
-- matches ON CONFLICT against a real unique index, so a constraint on anything
-- else - base_model alone, or a surrogate PK with no unique on the pair - makes
-- every PUT fail with 42P10 rather than 404. That is not hypothetical: the exact
-- failure shipped in special_addons, where 0087 replaced a single-column unique
-- with a per-company one and /save kept upserting onConflict: 'code'. Every Save
-- returned 500 for weeks. If this pair is ever changed, change sofa-combos.ts in
-- the same PR.
--
-- Per-company from the START, not retrofitted. 0087 had to convert four masters
-- to (company_id, code) after the fact; there is no reason to repeat that here.
--
-- No FK to scm.suppliers, deliberately: no table in this schema references
-- suppliers, and an anchor is a preference, not a dependency - a supplier row
-- disappearing should not block its removal. A stale supplier_id resolves to no
-- match in the UI's supplier list and the anchor simply reads as unset.
--
-- Houzs conventions: schema-qualified to scm.*; SET search_path; NO inner
-- BEGIN/COMMIT (the pg-migrate runner owns ONE transaction); additive and
-- IF NOT EXISTS so a re-run is safe. One-line DO block (the runner splits on
-- ';\n').

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.sofa_combo_anchor (
  company_id   bigint      NOT NULL,
  base_model   text        NOT NULL,
  supplier_id  uuid        NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The key sofa-combos.ts:452 names in its ON CONFLICT. See the header.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sofa_combo_anchor_company_base_model_key') THEN ALTER TABLE scm.sofa_combo_anchor ADD CONSTRAINT sofa_combo_anchor_company_base_model_key UNIQUE (company_id, base_model); END IF; END $$;

COMMENT ON TABLE scm.sofa_combo_anchor IS
  'R8 combo anchor: pins one base_model to ONE supplier. While anchored, every sofa_combo_pricing create/edit is mirrored between the master (supplier_id NULL) and that supplier''s scope, so the sales-side reference and the anchored supplier cost stay in lock-step. Empty table = nothing anchored = no behaviour change. UNIQUE (company_id, base_model) is what sofa-combos.ts upserts against - see docs/modules/combo-pricing.md section 6.';
