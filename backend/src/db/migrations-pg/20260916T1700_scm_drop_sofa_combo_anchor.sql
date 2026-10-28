-- 20260916T1700_scm_drop_sofa_combo_anchor.sql
-- Remove the sofa-combo Anchor feature (owner 2026-09-16). The manual per-model
-- "anchor to one supplier" mirror is redundant now that the combo COST
-- auto-derives from the most-expensive supplier (auto-derive stage 5b). Verified
-- SAFE before dropping: scm.sofa_combo_anchor held 0 rows in BOTH companies and
-- the auto-derive flag was OFF, so mirrorAnchoredCombo never fired — nothing
-- depended on it at runtime. The route, hooks and UI control are removed in the
-- same PR.
--
-- REVERSAL: recreate the table (it was created by 0283_scm_sofa_combo_anchor.sql):
--   CREATE TABLE IF NOT EXISTS scm.sofa_combo_anchor (
--     company_id  bigint NOT NULL,
--     base_model  text   NOT NULL,
--     supplier_id uuid,
--     created_by  uuid,
--     created_at  timestamptz NOT NULL DEFAULT now(),
--     updated_at  timestamptz NOT NULL DEFAULT now(),
--     PRIMARY KEY (company_id, base_model)
--   );
-- It carried no data, so no rows need restoring. No view, no grants to restore.

SET search_path = public, scm;

DROP TABLE IF EXISTS scm.sofa_combo_anchor;
