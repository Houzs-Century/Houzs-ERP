-- 20260924T1100_scm_vp_catalogue_live.sql
--
-- ERP -> Venture Portal: the CATALOGUE push becomes live — seconds after a
-- Save, like the order feed — instead of waiting for the five-minute cron.
--
-- WHY. Owner 2026-09-24: "i want it live, like current sales order sync, not 5
-- min". The order feed is live because its capture trigger records a change in
-- the SAME transaction as the Save and the SCM write kick drains it straight
-- after the response (scm/lib/venture-portal-kick.ts). The catalogue had no
-- capture: only the */5 cron asked whether its digest had moved.
--
-- WHAT. A statement trigger on each table the catalogue is built from marks
-- scm.venture_portal_catalogue_changes; after every SCM write the kick drains
-- the order queue and then, while a mark is there, runs the catalogue push
-- (scm/lib/venture-portal-catalogue.ts pushVenturePortalCatalogueOnChange),
-- which still sends only when the digest changed. The */5 cron keeps running
-- the same push and stays the safety net for a change made outside a request.
--
-- ONLY WHAT THE CATALOGUE SENDS COUNTS. vp_build_catalogue names its columns;
-- the UPDATE triggers name the same ones, so a cost, stock, usage, price or
-- photo update — the frequent writes on these tables — marks nothing and costs
-- no digest. INSERT and DELETE always mark. updated_at / created_at are sent but
-- never the reason a row changed, so they are not listed.
--
-- PER STATEMENT, NOT PER ROW, and into its own append-only table: a bulk update
-- of two thousand SKUs is one mark, and concurrent Saves never wait on one
-- another's mark (no shared row is updated). The push clears the marks it
-- covers before it builds, so a mark written meanwhile earns the next push.
--
-- SECURITY DEFINER because the writers are many roles (the service role, the
-- Hyperdrive origin roles, a session through PostgREST) and none of them is
-- granted this table; the function inserts one fixed row and nothing else.
--
-- REVERSAL: DROP TRIGGER IF EXISTS vp_catalogue_changed ON scm.mfg_products,
--   and vp_catalogue_changed_upd on the same table; the same two on
--   scm.product_models, scm.maintenance_config_history, scm.special_addons,
--   scm.fabric_trackings and scm.sofa_combo_pricing; then
--   DROP FUNCTION IF EXISTS scm.vp_catalogue_mark_changed();
--   DROP TABLE IF EXISTS scm.venture_portal_catalogue_changes;
--   The Worker treats a missing table as "no mark" and falls back to the cron.
--   No existing table's data or grants are altered.
-- Verified against: production (anogrigyjbduyzclzjgn), read-only via the
--   Supabase MCP on 2026-09-24 — every column named below exists on its table.

CREATE TABLE IF NOT EXISTS scm.venture_portal_catalogue_changes (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source      text        NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE scm.venture_portal_catalogue_changes IS
  'ERP -> Venture Portal catalogue push: one row per statement that changed a column the catalogue sends (statement triggers vp_catalogue_changed*). The SCM write kick sends the catalogue while a row is here; every push clears the rows it covers. Written by triggers, read and cleared by scm/lib/venture-portal-catalogue.ts.';

CREATE OR REPLACE FUNCTION scm.vp_catalogue_mark_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public
AS $fn$
BEGIN
  INSERT INTO scm.venture_portal_catalogue_changes (source) VALUES (TG_TABLE_NAME);
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION scm.vp_catalogue_mark_changed() IS
  'Statement trigger: marks the Venture Portal catalogue changed (scm.venture_portal_catalogue_changes). See 20260924T1100_scm_vp_catalogue_live.sql.';

-- ── The SKU master: identity, naming, sizing, model, status ────────────────
DROP TRIGGER IF EXISTS vp_catalogue_changed ON scm.mfg_products;
CREATE TRIGGER vp_catalogue_changed
  AFTER INSERT OR DELETE ON scm.mfg_products
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();
DROP TRIGGER IF EXISTS vp_catalogue_changed_upd ON scm.mfg_products;
CREATE TRIGGER vp_catalogue_changed_upd
  AFTER UPDATE OF company_id, code, name, description, category, model_id, base_model,
                  size_code, size_label, branding, barcode, fabric_color, status
  ON scm.mfg_products
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();

-- ── Modular: the model and its allowed options (not its photo) ─────────────
DROP TRIGGER IF EXISTS vp_catalogue_changed ON scm.product_models;
CREATE TRIGGER vp_catalogue_changed
  AFTER INSERT OR DELETE ON scm.product_models
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();
DROP TRIGGER IF EXISTS vp_catalogue_changed_upd ON scm.product_models;
CREATE TRIGGER vp_catalogue_changed_upd
  AFTER UPDATE OF company_id, model_code, name, category, branding, description, active, allowed_options
  ON scm.product_models
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();

-- ── The Bedframe / Sofa maintenance pools ───────────────────────────────────
DROP TRIGGER IF EXISTS vp_catalogue_changed ON scm.maintenance_config_history;
CREATE TRIGGER vp_catalogue_changed
  AFTER INSERT OR DELETE ON scm.maintenance_config_history
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();
DROP TRIGGER IF EXISTS vp_catalogue_changed_upd ON scm.maintenance_config_history;
CREATE TRIGGER vp_catalogue_changed_upd
  AFTER UPDATE OF company_id, scope, config, effective_from
  ON scm.maintenance_config_history
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();

-- ── Specials (not their prices or option groups) ────────────────────────────
DROP TRIGGER IF EXISTS vp_catalogue_changed ON scm.special_addons;
CREATE TRIGGER vp_catalogue_changed
  AFTER INSERT OR DELETE ON scm.special_addons
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();
DROP TRIGGER IF EXISTS vp_catalogue_changed_upd ON scm.special_addons;
CREATE TRIGGER vp_catalogue_changed_upd
  AFTER UPDATE OF company_id, code, label, categories, active, sort_order
  ON scm.special_addons
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();

-- ── Fabrics: code, series and tier (not their price, stock or usage) ────────
DROP TRIGGER IF EXISTS vp_catalogue_changed ON scm.fabric_trackings;
CREATE TRIGGER vp_catalogue_changed
  AFTER INSERT OR DELETE ON scm.fabric_trackings
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();
DROP TRIGGER IF EXISTS vp_catalogue_changed_upd ON scm.fabric_trackings;
CREATE TRIGGER vp_catalogue_changed_upd
  AFTER UPDATE OF company_id, fabric_code, fabric_description, fabric_category, series,
                  price_tier, sofa_price_tier, bedframe_price_tier, is_active
  ON scm.fabric_trackings
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();

-- ── Combos: slots, tier, the seat heights on offer, and retirement ─────────
-- prices_by_height is listed for its KEYS (the heights the catalogue sends);
-- a change to its values alone costs one digest and sends nothing.
DROP TRIGGER IF EXISTS vp_catalogue_changed ON scm.sofa_combo_pricing;
CREATE TRIGGER vp_catalogue_changed
  AFTER INSERT OR DELETE ON scm.sofa_combo_pricing
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();
DROP TRIGGER IF EXISTS vp_catalogue_changed_upd ON scm.sofa_combo_pricing;
CREATE TRIGGER vp_catalogue_changed_upd
  AFTER UPDATE OF company_id, base_model, modules, tier, customer_id, supplier_id,
                  prices_by_height, label, effective_from, deleted_at
  ON scm.sofa_combo_pricing
  FOR EACH STATEMENT EXECUTE FUNCTION scm.vp_catalogue_mark_changed();

-- ── Grants ──────────────────────────────────────────────────────────────────
-- The PostgREST service role reads and clears the marks; nobody calls the
-- trigger function directly.
DO $grant$
BEGIN
  REVOKE ALL ON FUNCTION scm.vp_catalogue_mark_changed() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, DELETE ON scm.venture_portal_catalogue_changes TO service_role;
  END IF;
END
$grant$;
