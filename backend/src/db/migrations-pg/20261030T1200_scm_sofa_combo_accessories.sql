-- Sofa accessory selections belong to POS combos and saved Quick Pick layouts.
-- REVERSAL: deploy the previous Worker, restore pos_sofa_combo_insert from
-- 20260926T1800_scm_pos_sofa_combos.sql, then drop the three added columns.
-- Export accessory-bearing combos/layouts first; dropping those columns loses them.
ALTER TABLE scm.pos_sofa_combos ADD COLUMN IF NOT EXISTS accessories jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE scm.sofa_quick_picks ADD COLUMN IF NOT EXISTS layout jsonb;
ALTER TABLE scm.personal_quick_picks ADD COLUMN IF NOT EXISTS layout jsonb;

CREATE OR REPLACE FUNCTION scm.pos_sofa_combo_insert(p_company_id bigint, p_row jsonb, p_actor jsonb)
RETURNS scm.pos_sofa_combos
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public, pg_temp
AS $fn$
DECLARE
  v scm.pos_sofa_combos;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'pos_sofa_combo_insert: company_id is required';
  END IF;

  PERFORM set_config('scm.pos_sofa_combo_writer', 'pos', true);

  INSERT INTO scm.pos_sofa_combos
    (company_id, base_model, modules, accessories, tier, selling_prices_by_height, pwp_prices_by_height,
     default_free_gifts, label, effective_from, notes, created_by, created_by_name)
  VALUES
    (p_company_id,
     p_row ->> 'base_model',
     COALESCE(p_row -> 'modules', '[]'::jsonb),
     COALESCE(p_row -> 'accessories', '[]'::jsonb),
     NULLIF(p_row ->> 'tier', ''),
     COALESCE(p_row -> 'selling_prices_by_height', '{}'::jsonb),
     COALESCE(p_row -> 'pwp_prices_by_height', '{}'::jsonb),
     COALESCE(p_row -> 'default_free_gifts', '[]'::jsonb),
     p_row ->> 'label',
     (p_row ->> 'effective_from')::date,
     p_row ->> 'notes',
     NULLIF(p_row ->> 'created_by', '')::uuid,
     p_actor ->> 'name')
  RETURNING * INTO v;

  INSERT INTO scm.pos_sofa_combo_audit
    (company_id, combo_id, action, actor_user_id, actor_name, actor_email, detail)
  VALUES
    (p_company_id, v.id, 'create',
     NULLIF(p_actor ->> 'user_id', '')::bigint, p_actor ->> 'name', p_actor ->> 'email',
     jsonb_build_object('base_model', v.base_model, 'modules', v.modules, 'accessories', v.accessories,
                        'selling_prices_by_height', v.selling_prices_by_height,
                        'effective_from', v.effective_from));

  PERFORM set_config('scm.pos_sofa_combo_writer', '', true);
  RETURN v;
END
$fn$;

NOTIFY pgrst, 'reload schema';
