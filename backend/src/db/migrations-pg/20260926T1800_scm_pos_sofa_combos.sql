-- 20260926T1800_scm_pos_sofa_combos.sql
-- 2990's POS selling combos get their own table, and only the 2990 POS can write it.
--
-- WHY. scm.sofa_combo_pricing held two owners in one namespace. For company 2
-- the master rows (supplier_id NULL) were the 2990 POS's SELLING prices, and the
-- same rows were Houzs's COST anchor (auto-derive, delete-unbound-sofa-combos,
-- ERP Products > Combos). 2026-09-25: delete-unbound-sofa-combos.mjs retired 96
-- of 2990's combos as "unbound" (the POS authors at PRICE_1, the supplier combos
-- sat at PRICE_2). 2026-09-26: cost rows keyed through ERP Products > Combos
-- (selling = cost) overrode 2990's combos on the POS, because the newest
-- effective_from wins the match. Owner ruling 2026-09-26: Houzs combos are
-- Houzs's cost, 2990 combos are the POS's selling price, the two sets may
-- differ, and Houzs may not change 2990's.
--
-- WHAT.
--   scm.pos_sofa_combos       company 2's selling combos. No cost column.
--   scm.pos_sofa_combo_audit  who created / retired which combo (the real
--                             person; created_by is the pinned SCM system id).
--   Writes go only through scm.pos_sofa_combo_insert / scm.pos_sofa_combo_retire
--   (SECURITY DEFINER, EXECUTE for service_role only), called by
--   /api/scm/pos-pools/sofa-combos. service_role holds no INSERT/UPDATE grant,
--   and a trigger refuses any write that does not come through those functions
--   plus every DELETE / TRUNCATE, so a script, an ERP screen or a future feature
--   cannot change these rows by accident.
--   The selling readers (SO recompute, PWP, special delivery, sales analysis,
--   the POS catalogue) read this table for the '2990' company; company 1 is
--   unchanged. sofa_combo_pricing stays Houzs's (cost), including the company-2
--   rows copied below, which no POS path reads any more.
--
-- DATA. Copies company 2's POS-authored combos with their ids (PWP rules and
-- special-delivery targets reference combo ids): every company-2 master
-- PRICE_1 row created before 2026-09-26 (live and retired, so History keeps its
-- versions), plus any PRICE_1 row the temporary lock scm.pos_combo_lock_2990
-- (applied by hand 2026-09-26) had locked. PRICE_2 / PRICE_3 / no-tier master
-- rows stay Houzs's: the POS authors only PRICE_1 and prices only at PRICE_1.
-- Then drops that temporary lock.
--
-- REVERSAL: deploy the previous Worker first (its readers use sofa_combo_pricing), then
--   DROP FUNCTION IF EXISTS scm.pos_sofa_combo_insert(bigint, jsonb, jsonb);
--   DROP FUNCTION IF EXISTS scm.pos_sofa_combo_retire(bigint, uuid, jsonb);
--   DROP TABLE IF EXISTS scm.pos_sofa_combo_audit;
--   DROP TABLE IF EXISTS scm.pos_sofa_combos;
--   DROP FUNCTION IF EXISTS scm.pos_sofa_combos_guard();
--   DROP FUNCTION IF EXISTS scm.pos_sofa_combo_audit_guard();
-- Combos created on the POS after this migration exist only here; copy them back
-- into sofa_combo_pricing before dropping.

CREATE TABLE IF NOT EXISTS scm.pos_sofa_combos (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               bigint      NOT NULL REFERENCES public.companies(id),
  base_model               text        NOT NULL,
  modules                  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tier                     text        CHECK (tier IN ('PRICE_1', 'PRICE_2', 'PRICE_3')),
  selling_prices_by_height jsonb       NOT NULL DEFAULT '{}'::jsonb,
  pwp_prices_by_height     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  default_free_gifts       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  label                    text,
  effective_from           date        NOT NULL,
  deleted_at               timestamptz,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid,
  created_by_name          text
);

CREATE INDEX IF NOT EXISTS pos_sofa_combos_company_model_idx
  ON scm.pos_sofa_combos (company_id, base_model)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE scm.pos_sofa_combos IS
  '2990 POS selling combos. Written only by scm.pos_sofa_combo_insert / scm.pos_sofa_combo_retire (via /api/scm/pos-pools/sofa-combos). Houzs cost combos live in scm.sofa_combo_pricing.';

CREATE TABLE IF NOT EXISTS scm.pos_sofa_combo_audit (
  id            bigserial   PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  company_id    bigint      NOT NULL,
  combo_id      uuid        NOT NULL,
  action        text        NOT NULL CHECK (action IN ('create', 'retire', 'import')),
  actor_user_id bigint,
  actor_name    text,
  actor_email   text,
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS pos_sofa_combo_audit_combo_idx
  ON scm.pos_sofa_combo_audit (combo_id);

-- ── The guard ───────────────────────────────────────────────────────────────
-- A transaction-local setting is the writer's credential: only the two
-- functions below set it. A combo is append-only; its one allowed update is
-- being retired (deleted_at NULL -> now()).
CREATE OR REPLACE FUNCTION scm.pos_sofa_combos_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'pos_sofa_combos: 2990 POS combos are never deleted. Retire one from the 2990 POS (owner ruling 2026-09-26).';
  END IF;

  IF current_setting('scm.pos_sofa_combo_writer', true) IS DISTINCT FROM 'pos' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'pos_sofa_combos: 2990 POS selling combos are written only by the 2990 POS. Houzs screens and scripts may not change them (owner ruling 2026-09-26).';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.deleted_at IS NOT NULL
          OR NEW.deleted_at IS NULL
          OR (to_jsonb(NEW) - 'deleted_at' - 'updated_at')
             IS DISTINCT FROM (to_jsonb(OLD) - 'deleted_at' - 'updated_at')) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'pos_sofa_combos: a combo is append-only. The only change allowed is retiring it.';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS pos_sofa_combos_guard ON scm.pos_sofa_combos;
CREATE TRIGGER pos_sofa_combos_guard
  BEFORE INSERT OR UPDATE OR DELETE ON scm.pos_sofa_combos
  FOR EACH ROW EXECUTE FUNCTION scm.pos_sofa_combos_guard();

DROP TRIGGER IF EXISTS pos_sofa_combos_no_truncate ON scm.pos_sofa_combos;
CREATE TRIGGER pos_sofa_combos_no_truncate
  BEFORE TRUNCATE ON scm.pos_sofa_combos
  FOR EACH STATEMENT EXECUTE FUNCTION scm.pos_sofa_combos_guard();

CREATE OR REPLACE FUNCTION scm.pos_sofa_combo_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'pos_sofa_combo_audit is append-only.';
END
$fn$;

DROP TRIGGER IF EXISTS pos_sofa_combo_audit_guard ON scm.pos_sofa_combo_audit;
CREATE TRIGGER pos_sofa_combo_audit_guard
  BEFORE UPDATE OR DELETE ON scm.pos_sofa_combo_audit
  FOR EACH ROW EXECUTE FUNCTION scm.pos_sofa_combo_audit_guard();

DROP TRIGGER IF EXISTS pos_sofa_combo_audit_no_truncate ON scm.pos_sofa_combo_audit;
CREATE TRIGGER pos_sofa_combo_audit_no_truncate
  BEFORE TRUNCATE ON scm.pos_sofa_combo_audit
  FOR EACH STATEMENT EXECUTE FUNCTION scm.pos_sofa_combo_audit_guard();

-- ── The only writers ────────────────────────────────────────────────────────
-- p_row keys are the table's column names. p_actor = { user_id, name, email }
-- of the REAL caller (houzsUser), not the pinned SCM system staff id.
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
    (company_id, base_model, modules, tier, selling_prices_by_height, pwp_prices_by_height,
     default_free_gifts, label, effective_from, notes, created_by, created_by_name)
  VALUES
    (p_company_id,
     p_row ->> 'base_model',
     COALESCE(p_row -> 'modules', '[]'::jsonb),
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
     jsonb_build_object('base_model', v.base_model, 'modules', v.modules,
                        'selling_prices_by_height', v.selling_prices_by_height,
                        'effective_from', v.effective_from));

  PERFORM set_config('scm.pos_sofa_combo_writer', '', true);
  RETURN v;
END
$fn$;

CREATE OR REPLACE FUNCTION scm.pos_sofa_combo_retire(p_company_id bigint, p_id uuid, p_actor jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = scm, public, pg_temp
AS $fn$
DECLARE
  n integer;
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'pos_sofa_combo_retire: company_id is required';
  END IF;

  PERFORM set_config('scm.pos_sofa_combo_writer', 'pos', true);

  UPDATE scm.pos_sofa_combos
     SET deleted_at = now(), updated_at = now()
   WHERE id = p_id
     AND company_id = p_company_id
     AND deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;

  IF n > 0 THEN
    INSERT INTO scm.pos_sofa_combo_audit
      (company_id, combo_id, action, actor_user_id, actor_name, actor_email)
    VALUES
      (p_company_id, p_id, 'retire',
       NULLIF(p_actor ->> 'user_id', '')::bigint, p_actor ->> 'name', p_actor ->> 'email');
  END IF;

  PERFORM set_config('scm.pos_sofa_combo_writer', '', true);
  RETURN n > 0;
END
$fn$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read-only for service_role; writes only by executing the two functions.
ALTER TABLE scm.pos_sofa_combos ENABLE ROW LEVEL SECURITY;
ALTER TABLE scm.pos_sofa_combo_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON scm.pos_sofa_combos, scm.pos_sofa_combo_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION scm.pos_sofa_combo_insert(bigint, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION scm.pos_sofa_combo_retire(bigint, uuid, jsonb) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON scm.pos_sofa_combos, scm.pos_sofa_combo_audit FROM anon;
    REVOKE ALL ON FUNCTION scm.pos_sofa_combo_insert(bigint, jsonb, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION scm.pos_sofa_combo_retire(bigint, uuid, jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON scm.pos_sofa_combos, scm.pos_sofa_combo_audit FROM authenticated;
    REVOKE ALL ON FUNCTION scm.pos_sofa_combo_insert(bigint, jsonb, jsonb) FROM authenticated;
    REVOKE ALL ON FUNCTION scm.pos_sofa_combo_retire(bigint, uuid, jsonb) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON scm.pos_sofa_combos, scm.pos_sofa_combo_audit FROM service_role;
    GRANT SELECT ON scm.pos_sofa_combos, scm.pos_sofa_combo_audit TO service_role;
    GRANT EXECUTE ON FUNCTION scm.pos_sofa_combo_insert(bigint, jsonb, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION scm.pos_sofa_combo_retire(bigint, uuid, jsonb) TO service_role;
  END IF;
END
$grant$;

-- ── Data: company 2's POS-authored combos, ids preserved ────────────────────
DO $copy$
DECLARE
  lock_clause text := '';
BEGIN
  IF to_regclass('scm.sofa_combo_pricing') IS NULL THEN
    RETURN;
  END IF;
  IF to_regclass('scm.pos_combo_lock_2990') IS NOT NULL THEN
    lock_clause := 'OR s.id IN (SELECT combo_id FROM scm.pos_combo_lock_2990)';
  END IF;

  PERFORM set_config('scm.pos_sofa_combo_writer', 'pos', true);

  EXECUTE format($q$
    INSERT INTO scm.pos_sofa_combos
      (id, company_id, base_model, modules, tier, selling_prices_by_height, pwp_prices_by_height,
       default_free_gifts, label, effective_from, deleted_at, notes, created_at, updated_at, created_by)
    SELECT s.id, s.company_id, s.base_model, s.modules, s.tier::text,
           COALESCE(s.selling_prices_by_height, '{}'::jsonb),
           COALESCE(s.pwp_prices_by_height, '{}'::jsonb),
           COALESCE(s.default_free_gifts, '[]'::jsonb),
           s.label, s.effective_from, s.deleted_at, s.notes, s.created_at, s.updated_at, s.created_by
      FROM scm.sofa_combo_pricing s
      JOIN public.companies co ON co.id = s.company_id AND co.code = '2990'
     WHERE s.supplier_id IS NULL
       AND s.customer_id IS NULL
       AND s.tier::text = 'PRICE_1'
       AND (s.created_at < '2026-09-26 00:00:00+00' %s)
    ON CONFLICT (id) DO NOTHING
  $q$, lock_clause);

  INSERT INTO scm.pos_sofa_combo_audit (company_id, combo_id, action, actor_name, detail)
  SELECT p.company_id, p.id, 'import', 'migration 20260926T1800',
         jsonb_build_object('from', 'scm.sofa_combo_pricing')
    FROM scm.pos_sofa_combos p
   WHERE NOT EXISTS (SELECT 1 FROM scm.pos_sofa_combo_audit a
                      WHERE a.combo_id = p.id AND a.action = 'import');

  PERFORM set_config('scm.pos_sofa_combo_writer', '', true);
END
$copy$;

-- ── Drop the temporary hand-applied lock (2026-09-26) ───────────────────────
-- It protected the company-2 rows in sofa_combo_pricing while the POS still read
-- them. Nothing on the POS reads them after this deploy.
DO $unlock$
BEGIN
  IF to_regclass('scm.sofa_combo_pricing') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_sofa_combo_2990_lock ON scm.sofa_combo_pricing;
    DROP TRIGGER IF EXISTS trg_sofa_combo_2990_autolock ON scm.sofa_combo_pricing;
  END IF;
END
$unlock$;
DROP FUNCTION IF EXISTS scm.sofa_combo_2990_lock();
DROP FUNCTION IF EXISTS scm.sofa_combo_2990_autolock();
DROP TABLE IF EXISTS scm.pos_combo_lock_2990;

NOTIFY pgrst, 'reload schema';
