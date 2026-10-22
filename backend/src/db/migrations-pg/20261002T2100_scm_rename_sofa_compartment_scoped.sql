-- 20261002T2100_scm_rename_sofa_compartment_scoped.sql
-- REVERSAL: DROP FUNCTION IF EXISTS scm.rename_sofa_compartment(bigint, text, text, boolean);
--   DROP FUNCTION IF EXISTS scm.jsonb_replace_string_value(jsonb, text, text);
--   then re-run the CREATE FUNCTION scm.rename_sofa_compartment(text, text) block
--   of 0307_item_code_unify.sql and GRANT EXECUTE ON it TO service_role only
--   (before this migration it was also executable by PUBLIC; do not restore that).
--   Revert the route (maintenance-config.ts) first: it calls the 4-argument form.
--   GRANTS: this file revokes PUBLIC/anon/authenticated and grants service_role.
--
-- WHAT THIS CHANGES: replaces the compartment cascade rename. No row is written
-- by the migration itself.
--
-- WHY (owner 2026-10-02, 只准改没用过的): the old function renamed a compartment
-- across EVERY company (renaming HOUZS "Console" also rewrote 2990's 3 SKUs and
-- 51 config rows), rewrote SKU codes and historical doc-line item codes while
-- leaving inventory_movements/balances on the old code, and text-replaced the
-- token in every maintenance config blob. The compartment code is part of every
-- SKU code (`<MODEL>-<compartment>`, product-models.ts), so a compartment that is
-- in use cannot be renamed safely at all. Now:
--   * one company only (p_company_id), on every read and write;
--   * p_apply = false is a preview: counts only, no write;
--   * refused (applied=false, refused='in_use') while ANY SKU, doc line, stock
--     row, price override, binding, PWP code, legacy per-model compartment, POS
--     combo or personal quick pick of this company still uses the code;
--   * otherwise rewrites only this company's compartment pool + its photo/
--     description entry, Model allowed compartments, combos and quick picks,
--     matching exact JSON string values (never keys, never substrings);
--   * the new code must parse as a compartment (no spaces) and keep
--     `<longest SOFA model code>-<code>` within AutoCount's 30-char item code.

DROP FUNCTION IF EXISTS scm.rename_sofa_compartment(text, text);

CREATE OR REPLACE FUNCTION scm.jsonb_replace_string_value(j jsonb, p_from text, p_to text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'scm', 'pg_temp'
AS $fn$
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'string' THEN
      IF j #>> '{}' = p_from THEN RETURN to_jsonb(p_to); END IF;
      RETURN j;
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(scm.jsonb_replace_string_value(e, p_from, p_to) ORDER BY o)
                         FROM jsonb_array_elements(j) WITH ORDINALITY AS t(e, o)), '[]'::jsonb);
    WHEN 'object' THEN
      RETURN coalesce((SELECT jsonb_object_agg(k, scm.jsonb_replace_string_value(v, p_from, p_to))
                         FROM jsonb_each(j) AS t(k, v)), '{}'::jsonb);
    ELSE
      RETURN j;
  END CASE;
END;
$fn$;

CREATE OR REPLACE FUNCTION scm.rename_sofa_compartment(
  p_company_id bigint, p_from text, p_to text, p_apply boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'scm', 'pg_temp'
AS $fn$
DECLARE
  v_from      text := trim(coalesce(p_from, ''));
  v_to        text := trim(coalesce(p_to, ''));
  v_suffix    text;
  v_has_from  jsonb;
  v_longest   int;
  v_pool      jsonb;
  in_use      jsonb := '{}'::jsonb;
  in_use_n    bigint := 0;
  changes     jsonb := '{}'::jsonb;
  n           bigint;
  t           record;
  v_photo     boolean;
BEGIN
  IF p_company_id IS NULL THEN RAISE EXCEPTION 'company_required'; END IF;
  IF p_apply IS NULL THEN RAISE EXCEPTION 'apply_required'; END IF;
  IF v_from = '' OR v_to = '' THEN RAISE EXCEPTION 'empty_code'; END IF;
  IF v_from = v_to THEN RAISE EXCEPTION 'same_code'; END IF;
  -- parseCompartmentStructure (sofa-build.ts) grammar, with no whitespace at all.
  IF v_to !~ '^[^()[:space:]]+(\([^()[:space:]]*\))*$' THEN RAISE EXCEPTION 'invalid_code'; END IF;

  SELECT max(length(m.model_code)) INTO v_longest
    FROM product_models m
   WHERE m.company_id = p_company_id AND m.category::text = 'SOFA';
  IF coalesce(v_longest, 0) + 1 + length(v_to) > 30 THEN RAISE EXCEPTION 'code_too_long'; END IF;

  -- Taken in this company's current master pool, or in a future-dated one.
  FOR v_pool IN
    SELECT h.config->'sofaCompartments'
      FROM maintenance_config_history h
     WHERE h.company_id = p_company_id AND h.scope = 'master'
       AND (h.effective_from > CURRENT_DATE
            OR h.id = (SELECT h2.id FROM maintenance_config_history h2
                        WHERE h2.company_id = p_company_id AND h2.scope = 'master'
                          AND h2.effective_from <= CURRENT_DATE
                        ORDER BY h2.effective_from DESC, h2.created_at DESC LIMIT 1))
  LOOP
    IF coalesce(jsonb_path_exists(v_pool, '$.** ? (@ == $s)', jsonb_build_object('s', v_to)), false) THEN
      RAISE EXCEPTION 'code_exists';
    END IF;
  END LOOP;

  v_suffix := '-' || v_from;
  v_has_from := jsonb_build_object('s', v_from);

  -- ── In use? Every item-code column of this company ending in -<from> ──
  FOR t IN SELECT * FROM (VALUES
      ('mfg_products', 'code'),
      ('mfg_sales_order_items', 'item_code'),
      ('mfg_so_price_overrides', 'item_code'),
      ('delivery_order_items', 'item_code'),
      ('delivery_return_items', 'item_code'),
      ('sales_invoice_items', 'item_code'),
      ('consignment_sales_order_items', 'item_code'),
      ('consignment_delivery_order_items', 'item_code'),
      ('consignment_delivery_return_items', 'item_code'),
      ('purchase_order_items', 'item_code'),
      ('grn_items', 'item_code'),
      ('purchase_invoice_items', 'item_code'),
      ('purchase_return_items', 'item_code'),
      ('purchase_consignment_order_items', 'item_code'),
      ('purchase_consignment_receive_items', 'item_code'),
      ('purchase_consignment_return_items', 'item_code'),
      ('supplier_material_bindings', 'item_code'),
      ('pwp_codes', 'trigger_item_code'),
      ('pwp_codes', 'redeemed_item_code'),
      ('inventory_movements', 'item_code'),
      ('inventory_balances', 'item_code'),
      ('inventory_lots', 'item_code'),
      ('stock_transfer_lines', 'item_code'),
      ('stock_take_lines', 'item_code'),
      ('warehouse_rack_items', 'item_code')
    ) AS x(tbl, col)
  LOOP
    EXECUTE format('SELECT count(*) FROM scm.%I WHERE company_id = $1 AND right(%I, $2) = $3', t.tbl, t.col)
       INTO n USING p_company_id, length(v_suffix), v_suffix;
    in_use := in_use || jsonb_build_object(t.tbl || '.' || t.col, n);
    in_use_n := in_use_n + n;
  END LOOP;

  SELECT count(*) INTO n FROM product_compartments
   WHERE company_id = p_company_id AND compartment_id = v_from;
  in_use := in_use || jsonb_build_object('product_compartments.compartment_id', n);
  in_use_n := in_use_n + n;

  SELECT count(*) INTO n FROM pos_sofa_combos
   WHERE company_id = p_company_id
     AND coalesce(jsonb_path_exists(modules, '$.** ? (@ == $s)', v_has_from), false);
  in_use := in_use || jsonb_build_object('pos_sofa_combos.modules', n);
  in_use_n := in_use_n + n;

  -- No company_id on personal picks: a pick belongs to the company whose Model it is.
  SELECT count(*) INTO n FROM sofa_personal_quick_picks p
   WHERE p.base_model IN (SELECT m.model_code FROM product_models m WHERE m.company_id = p_company_id)
     AND coalesce(jsonb_path_exists(p.modules, '$.** ? (@ == $s)', v_has_from), false);
  in_use := in_use || jsonb_build_object('sofa_personal_quick_picks.modules', n);
  in_use_n := in_use_n + n;

  -- ── What a rename would change (same predicates as the writes below) ──
  SELECT count(*) INTO n FROM maintenance_config_history h
   WHERE h.company_id = p_company_id
     AND (coalesce(jsonb_path_exists(h.config->'sofaCompartments', '$.** ? (@ == $s)', v_has_from), false)
          OR (jsonb_typeof(h.config->'sofaCompartmentMeta') = 'object' AND (h.config->'sofaCompartmentMeta') ? v_from));
  changes := changes || jsonb_build_object('maintenance_config_history', n);

  SELECT count(*) INTO n FROM product_models m
   WHERE m.company_id = p_company_id
     AND coalesce(jsonb_path_exists(m.allowed_options->'compartments', '$.** ? (@ == $s)', v_has_from), false);
  changes := changes || jsonb_build_object('product_models', n);

  SELECT count(*) INTO n FROM sofa_combo_pricing s
   WHERE s.company_id = p_company_id
     AND coalesce(jsonb_path_exists(s.modules, '$.** ? (@ == $s)', v_has_from), false);
  changes := changes || jsonb_build_object('sofa_combo_pricing', n);

  SELECT count(*) INTO n FROM sofa_quick_picks q
   WHERE q.company_id = p_company_id
     AND coalesce(jsonb_path_exists(q.modules, '$.** ? (@ == $s)', v_has_from), false);
  changes := changes || jsonb_build_object('sofa_quick_picks', n);

  -- An uploaded photo lives under sofa-compartments/<code>/ and is only served
  -- for that code, so it cannot follow the rename.
  SELECT EXISTS (
    SELECT 1 FROM maintenance_config_history h
     WHERE h.company_id = p_company_id
       AND jsonb_typeof(h.config->'sofaCompartmentMeta') = 'object'
       AND coalesce(h.config->'sofaCompartmentMeta'->v_from->>'imageKey', '') LIKE 'sofa-compartments/%'
  ) INTO v_photo;

  IF NOT p_apply OR in_use_n > 0 THEN
    RETURN jsonb_build_object(
      'from', v_from, 'to', v_to, 'companyId', p_company_id,
      'applied', false,
      'refused', CASE WHEN in_use_n > 0 THEN 'in_use' ELSE NULL END,
      'inUse', in_use, 'inUseTotal', in_use_n,
      'changes', changes, 'photoCleared', v_photo);
  END IF;

  -- ── Apply: this company only ─────────────────────────────────────────
  UPDATE maintenance_config_history h
     SET config = CASE
           WHEN jsonb_typeof(c.cfg->'sofaCompartmentMeta') = 'object' AND (c.cfg->'sofaCompartmentMeta') ? v_from
           THEN jsonb_set(c.cfg, '{sofaCompartmentMeta}',
                  ((c.cfg->'sofaCompartmentMeta') - v_from)
                  || jsonb_build_object(v_to,
                       CASE WHEN jsonb_typeof(c.cfg->'sofaCompartmentMeta'->v_from) = 'object'
                             AND coalesce(c.cfg->'sofaCompartmentMeta'->v_from->>'imageKey', '') LIKE 'sofa-compartments/%'
                            THEN (c.cfg->'sofaCompartmentMeta'->v_from) - 'imageKey'
                            ELSE c.cfg->'sofaCompartmentMeta'->v_from END))
           ELSE c.cfg END
    FROM (SELECT h2.id,
                 CASE WHEN h2.config ? 'sofaCompartments'
                      THEN jsonb_set(h2.config, '{sofaCompartments}',
                             scm.jsonb_replace_string_value(h2.config->'sofaCompartments', v_from, v_to))
                      ELSE h2.config END AS cfg
            FROM maintenance_config_history h2
           WHERE h2.company_id = p_company_id
             AND (coalesce(jsonb_path_exists(h2.config->'sofaCompartments', '$.** ? (@ == $s)', v_has_from), false)
                  OR (jsonb_typeof(h2.config->'sofaCompartmentMeta') = 'object' AND (h2.config->'sofaCompartmentMeta') ? v_from))) c
   WHERE h.id = c.id AND h.company_id = p_company_id;

  UPDATE product_models m
     SET allowed_options = jsonb_set(m.allowed_options, '{compartments}',
           scm.jsonb_replace_string_value(m.allowed_options->'compartments', v_from, v_to))
   WHERE m.company_id = p_company_id
     AND coalesce(jsonb_path_exists(m.allowed_options->'compartments', '$.** ? (@ == $s)', v_has_from), false);

  UPDATE sofa_combo_pricing s
     SET modules = scm.jsonb_replace_string_value(s.modules, v_from, v_to)
   WHERE s.company_id = p_company_id
     AND coalesce(jsonb_path_exists(s.modules, '$.** ? (@ == $s)', v_has_from), false);

  UPDATE sofa_quick_picks q
     SET modules = scm.jsonb_replace_string_value(q.modules, v_from, v_to)
   WHERE q.company_id = p_company_id
     AND coalesce(jsonb_path_exists(q.modules, '$.** ? (@ == $s)', v_has_from), false);

  RETURN jsonb_build_object(
    'from', v_from, 'to', v_to, 'companyId', p_company_id,
    'applied', true, 'refused', NULL,
    'inUse', in_use, 'inUseTotal', in_use_n,
    'changes', changes, 'photoCleared', v_photo);
END;
$fn$;

REVOKE ALL ON FUNCTION scm.rename_sofa_compartment(bigint, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION scm.jsonb_replace_string_value(jsonb, text, text) FROM PUBLIC;
DO $grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION scm.rename_sofa_compartment(bigint, text, text, boolean) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION scm.rename_sofa_compartment(bigint, text, text, boolean) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION scm.rename_sofa_compartment(bigint, text, text, boolean) TO service_role;
    GRANT EXECUTE ON FUNCTION scm.jsonb_replace_string_value(jsonb, text, text) TO service_role;
  END IF;
END $grants$;
