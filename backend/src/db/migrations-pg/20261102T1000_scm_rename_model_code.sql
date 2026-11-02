-- 20261102T1000_scm_rename_model_code.sql
-- REVERSAL: DROP FUNCTION IF EXISTS scm.rename_model_code(bigint, uuid, text);
--   Revert the route (product-models.ts, PATCH /:id) first: it calls this function
--   for every model code change. Codes already renamed stay renamed.
--   GRANTS: this file revokes PUBLIC/anon/authenticated and grants service_role.
--
-- WHAT THIS CHANGES: adds one function. No row is written by the migration itself.
--
-- WHY (ticket 2990-0022, two way model name and code management): the model code
-- is copied onto its SKUs as mfg_products.base_model, the key sofa combo pricing,
-- the sofa quick picks and the personal quick picks match on. Saving a new
-- model_code used to change product_models only, so those rows kept the old
-- code and silently stopped matching. This function changes the model and every
-- keyed row in ONE transaction, for ONE company:
--   * model not in this company            -> refused 'not_found'
--   * new code empty / same as the old one -> refused 'empty_code' / unchanged
--   * another model of the company already has the new code, or any keyed row
--     already uses it                      -> refused 'code_taken'
--   * another model of the company still has the old code (it shares the key,
--     so a rewrite would take its rows too) -> refused 'code_shared'
--   * the 2990 POS combos (pos_sofa_combos) are append-only by owner ruling
--     2026-09-26 and cannot be rewritten here; while one is live under the old
--     code                                  -> refused 'pos_combos_in_use'
-- SKU item codes ({model_code}-{compartment}) are NOT renamed: they are on
-- documents, stock and AutoCount.

CREATE OR REPLACE FUNCTION scm.rename_model_code(
  p_company_id bigint, p_model_id uuid, p_new_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'scm', 'pg_temp'
AS $fn$
DECLARE
  v_new   text := trim(coalesce(p_new_code, ''));
  v_old   text;
  n       bigint;
  changed jsonb := '{}'::jsonb;
BEGIN
  IF p_company_id IS NULL THEN RAISE EXCEPTION 'company_required'; END IF;
  IF p_model_id IS NULL THEN RAISE EXCEPTION 'model_required'; END IF;

  SELECT model_code INTO v_old
    FROM scm.product_models
   WHERE id = p_model_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('renamed', false, 'refused', 'not_found'); END IF;
  IF v_new = '' THEN RETURN jsonb_build_object('renamed', false, 'refused', 'empty_code'); END IF;
  IF v_new = v_old THEN RETURN jsonb_build_object('renamed', false, 'unchanged', true); END IF;

  IF EXISTS (SELECT 1 FROM scm.product_models WHERE company_id = p_company_id AND id <> p_model_id AND model_code = v_new)
     OR EXISTS (SELECT 1 FROM scm.mfg_products WHERE company_id = p_company_id AND base_model = v_new)
     OR EXISTS (SELECT 1 FROM scm.sofa_combo_pricing WHERE company_id = p_company_id AND base_model = v_new)
     OR EXISTS (SELECT 1 FROM scm.sofa_quick_picks WHERE company_id = p_company_id AND base_model = v_new)
     OR EXISTS (SELECT 1 FROM scm.personal_quick_picks WHERE company_id = p_company_id AND base_model = v_new)
     OR EXISTS (SELECT 1 FROM scm.pos_sofa_combos WHERE company_id = p_company_id AND base_model = v_new)
  THEN RETURN jsonb_build_object('renamed', false, 'refused', 'code_taken'); END IF;

  IF EXISTS (SELECT 1 FROM scm.product_models WHERE company_id = p_company_id AND id <> p_model_id AND model_code = v_old)
     OR EXISTS (SELECT 1 FROM scm.mfg_products WHERE company_id = p_company_id AND base_model = v_old
                  AND model_id IS NOT NULL AND model_id <> p_model_id)
  THEN RETURN jsonb_build_object('renamed', false, 'refused', 'code_shared'); END IF;

  IF EXISTS (SELECT 1 FROM scm.pos_sofa_combos WHERE company_id = p_company_id AND base_model = v_old AND deleted_at IS NULL)
  THEN RETURN jsonb_build_object('renamed', false, 'refused', 'pos_combos_in_use'); END IF;

  UPDATE scm.mfg_products SET base_model = v_new
   WHERE company_id = p_company_id AND base_model = v_old;
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed || jsonb_build_object('mfg_products', n);
  UPDATE scm.sofa_combo_pricing SET base_model = v_new
   WHERE company_id = p_company_id AND base_model = v_old;
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed || jsonb_build_object('sofa_combo_pricing', n);
  UPDATE scm.sofa_quick_picks SET base_model = v_new
   WHERE company_id = p_company_id AND base_model = v_old;
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed || jsonb_build_object('sofa_quick_picks', n);
  UPDATE scm.personal_quick_picks SET base_model = v_new
   WHERE company_id = p_company_id AND base_model = v_old;
  GET DIAGNOSTICS n = ROW_COUNT; changed := changed || jsonb_build_object('personal_quick_picks', n);
  UPDATE scm.product_models SET model_code = v_new
   WHERE id = p_model_id AND company_id = p_company_id;

  RETURN jsonb_build_object('renamed', true, 'from', v_old, 'to', v_new, 'rows', changed);
END;
$fn$;

REVOKE ALL ON FUNCTION scm.rename_model_code(bigint, uuid, text) FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION scm.rename_model_code(bigint, uuid, text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION scm.rename_model_code(bigint, uuid, text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION scm.rename_model_code(bigint, uuid, text) TO service_role;
  END IF;
END $grants$;
