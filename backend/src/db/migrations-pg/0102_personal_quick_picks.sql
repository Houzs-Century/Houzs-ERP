-- ----------------------------------------------------------------------------
-- 0102 — scm.personal_quick_picks (port of 2990 sofa_personal_quick_picks, WS1)
--
-- A salesperson's PERSONAL saved Quick Pick sofa layouts, DB-backed so they
-- follow the person across devices (2990 Chairman 2026-05-31). Mirrors
-- scm.sofa_quick_picks (the global, admin-curated layer) but is OWNED per
-- salesperson: each row is scoped to the REAL caller + the active company.
--
-- Two Houzs-specific deviations from the 2990 original (sofa_personal_quick_picks):
--   1. Ownership key is `owner_user_id bigint` (the Houzs public user id), NOT
--      the 2990 `staff_id uuid`. Inside /api/scm/* the auth bridge pins
--      c.get('user').id to ONE shared system staff uuid for every caller, so a
--      uuid staff_id would collapse all salespeople onto one row. The route uses
--      c.get('houzsUser').id (the real integer caller) instead.
--   2. `company_id bigint` scopes rows per company (multi-company merge, mig 0061).
--
-- The 2990 import (scripts/scm-schema/2990s-full-schema.sql) shipped an unscoped
-- `sofa_personal_quick_picks` with a public.staff FK that was never wired to a
-- route; this new table supersedes it. Additive + idempotent (IF NOT EXISTS).
-- No price column — the card price is computed by the pricing engine.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scm.personal_quick_picks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     bigint NOT NULL,
  owner_user_id  bigint NOT NULL,                    -- Houzs public.users id (real caller)
  base_model     text NOT NULL,
  label          text,                               -- NULL = auto-build from modules
  modules        jsonb NOT NULL DEFAULT '[]'::jsonb, -- string[][], same shape as sofa_quick_picks
  depth          text NOT NULL,
  sort_order     integer NOT NULL DEFAULT 0,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- FK to the companies master (guarded: skip if the master is absent, e.g. a
-- single-company / pre-0061 environment — mirrors 0061's defensiveness).
DO $$ BEGIN IF to_regclass('public.companies') IS NOT NULL THEN ALTER TABLE scm.personal_quick_picks DROP CONSTRAINT IF EXISTS personal_quick_picks_company_id_fkey; ALTER TABLE scm.personal_quick_picks ADD CONSTRAINT personal_quick_picks_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); END IF; END $$;

-- Common lookup: a salesperson's active picks for one base model, in order,
-- within the active company.
CREATE INDEX IF NOT EXISTS idx_personal_quick_picks_lookup
  ON scm.personal_quick_picks (company_id, owner_user_id, base_model, sort_order)
  WHERE deleted_at IS NULL;

-- Service-role client (getSupabaseService, db.schema = 'scm') reaches this table
-- via PostgREST — belt-and-suspenders grant, matching the 0062 view grants.
GRANT ALL ON scm.personal_quick_picks TO service_role;

COMMENT ON TABLE scm.personal_quick_picks IS
  'Personal Quick Pick sofa layouts (WS1 port from 2990). Each salesperson''s own '
  'saved layouts, DB-backed so they follow the person across devices. Scoped by '
  'owner_user_id (Houzs public user id) + company_id. Separate from '
  'scm.sofa_quick_picks (global, admin-curated, no per-user scoping).';
