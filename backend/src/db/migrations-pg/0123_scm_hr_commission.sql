-- 0123: HR / Commission module — port of 2990 packages/db/migrations/0171_hr_commission.sql.
--
-- WHY
--   The HR module is the single blocker on retiring 2990's apps/api: it is the
--   only place anyone's commission is calculated. This file makes the three
--   hr_* tables CERTAIN, per-company, and SEEDED, so scm/routes/hr.ts can rely
--   on them regardless of what the out-of-band scm schema apply actually left
--   behind.
--
-- THE EXISTENCE QUESTION (read this before "simplifying" anything below)
--   0089_multicompany_extend_scoping.sql already ALTERs scm.hr_commission_config
--   / scm.hr_item_kpi / scm.hr_salesperson_profiles, but every block is wrapped
--   in a pg_class relkind guard, and NO repo file CREATEs them. The scm schema
--   was applied out-of-band and is in no repo, so the tree cannot prove their
--   state. What the tree DOES show:
--     · scripts/scm-schema/2990s-full-schema.sql (the vendored 2990 export that
--       built scm) CONTAINS all three tables + the hr_tier / hr_item_kpi_type
--       enums.
--     · scripts/scm-schema/apply-scm-schema.mjs applies that export WHOLE, in
--       ONE transaction (DROP SCHEMA scm CASCADE -> CREATE SCHEMA -> every
--       statement). It is all-or-nothing: there is no partial-apply state in
--       which scm.staff exists but scm.hr_item_kpi does not.
--     · migration 0099_pos_auth.sql creates scm.pos_pins with an UNGUARDED
--       `REFERENCES scm.staff(id)`, and it is deployed — so scm.staff exists in
--       prod today, which means that export WAS applied.
--   => the tables almost certainly EXIST with the export's shape. But "almost
--   certainly" is not a thing to bet payroll on, so every step here is written
--   to be correct in BOTH worlds: CREATE TABLE IF NOT EXISTS for the absent
--   case, and idempotent ALTERs (a replay of 0089's own logic) for the present
--   case. Re-running any step is a no-op.
--
-- WHAT THE EXPORT LOST (this is the real bug this file fixes)
--   The export is DDL-only — it carries ZERO INSERT statements. 2990's 0171
--   seeded the singleton config row (`INSERT INTO hr_commission_config (id)
--   VALUES (1)`), and that seed did NOT come across. So scm.hr_commission_config
--   is present-but-EMPTY, and 2990's /hr/config (`.eq('id',1).single()`) would
--   500 on the very first read. The seed below is not cosmetic — without it the
--   module cannot compute a single ringgit.
--   The export also dropped 2990's `CHECK (id = 1)` (drizzle exports omit CHECK
--   constraints), so the singleton constraint may or may not be there. Nothing
--   below depends on either answer.
--
-- PER-COMPANY CONFIG (a deliberate change from 2990, forced by the merge)
--   0089 stamped company_id on hr_commission_config but left the singleton
--   id=1 PK, noting "a per-company config needs a PK redesign first". That
--   redesign is now REQUIRED, not optional: with the row stamped HOUZS, a
--   company-scoped read while 2990 is the active company returns NOTHING, and a
--   missing config must never degrade into a confident 0% commission. So id
--   stops being a singleton (sequence-backed) and company_id becomes the
--   identity: UNIQUE(company_id), one seeded row per company. Rates come from
--   the column DEFAULTs — the SAME figures 2990's 0171 seeded (Loo's stated
--   rates: 1% base, 0.5% KPIs, RM100k personal / RM400k showroom, 0.5%
--   override), so a Houzs payout on day one matches 2990's to the sen.
--
-- CONVENTIONS
--   Timestamps here stay timestamptz, NOT the text convention from
--   0008_timestamp_text_fix.sql. That fix targets D1-heritage public.* tables
--   written through the d1-compat shim (datetime('now') -> to_char -> text).
--   scm.* is natively PG from the 2990 export and is written through PostgREST
--   with `new Date().toISOString()`, which casts to timestamptz correctly. Using
--   text here would diverge from every other scm table.
--
--   pg-migrate splits on /;\s*\n/ BEFORE stripping comments, so every DO block
--   is crammed onto ONE physical line (0089's pattern). The multi-line CREATE
--   TABLEs are safe: they carry no internal ';'.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1) enums ------------------------------------------------------------------
-- CREATE TYPE has no IF NOT EXISTS; guard on pg_type. Present already when the
-- export was applied (it carries both), created here on a schema that lacks them.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='scm' AND t.typname='hr_tier') THEN CREATE TYPE scm.hr_tier AS ENUM ('sales', 'manager'); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='scm' AND t.typname='hr_item_kpi_type') THEN CREATE TYPE scm.hr_item_kpi_type AS ENUM ('product', 'fabric', 'special'); END IF; END $$;

-- 2) tables (absent case) ---------------------------------------------------
-- Shapes match the 2990 export EXACTLY (so the present case is identical),
-- except: company_id is NOT NULL from birth, the staff_id UNIQUE is already the
-- composite 0089 converts to, and id carries no DEFAULT (step 5 owns it).

CREATE TABLE IF NOT EXISTS scm.hr_salesperson_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES scm.staff(id) ON DELETE CASCADE,
  tier        scm.hr_tier NOT NULL DEFAULT 'sales',
  showroom_id uuid NOT NULL REFERENCES scm.showrooms(id),
  active      boolean NOT NULL DEFAULT true,
  company_id  bigint NOT NULL REFERENCES public.companies(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_salesperson_profiles_company_staff_unique UNIQUE (company_id, staff_id)
);

CREATE TABLE IF NOT EXISTS scm.hr_commission_config (
  id                            integer PRIMARY KEY,
  base_bps                      integer NOT NULL DEFAULT 100,
  personal_kpi_threshold_centi  integer NOT NULL DEFAULT 10000000,
  personal_kpi_bonus_bps        integer NOT NULL DEFAULT 50,
  showroom_kpi_threshold_centi  integer NOT NULL DEFAULT 40000000,
  showroom_kpi_bonus_bps        integer NOT NULL DEFAULT 50,
  override_base_bps             integer NOT NULL DEFAULT 50,
  override_kpi_bonus_bps        integer NOT NULL DEFAULT 50,
  company_id                    bigint NOT NULL REFERENCES public.companies(id),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  updated_by                    uuid
);

CREATE TABLE IF NOT EXISTS scm.hr_item_kpi (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_type   scm.hr_item_kpi_type NOT NULL,
  ref         text NOT NULL,
  label       text NOT NULL DEFAULT '',
  bonus_centi integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  company_id  bigint NOT NULL REFERENCES public.companies(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 3) company_id stamp (present case) ----------------------------------------
-- A replay of 0089's per-table block, for the world where the table existed but
-- 0089's relkind guard skipped it (or the column was never added). A no-op when
-- 0089 already did the work, and a no-op on the tables step 2 just created.
--
-- SAFER THAN 0089 IN ONE RESPECT: SET NOT NULL only fires when no NULL remains.
-- 0089 backfills to (SELECT id FROM public.companies WHERE code='HOUZS') and
-- then SET NOT NULL unconditionally — if HOUZS were ever absent the backfill
-- writes NULL and the SET NOT NULL raises, which in migrations-pg does not just
-- fail this file, it BLOCKS EVERY DEPLOY. The extra guard costs nothing.

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_commission_config' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.hr_commission_config ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.hr_commission_config SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; IF NOT EXISTS (SELECT 1 FROM scm.hr_commission_config WHERE company_id IS NULL) THEN ALTER TABLE scm.hr_commission_config ALTER COLUMN company_id SET NOT NULL; END IF; ALTER TABLE scm.hr_commission_config DROP CONSTRAINT IF EXISTS hr_commission_config_company_id_fkey; ALTER TABLE scm.hr_commission_config ADD CONSTRAINT hr_commission_config_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_hr_commission_config_company_id ON scm.hr_commission_config (company_id); END IF; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_item_kpi' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.hr_item_kpi ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.hr_item_kpi SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; IF NOT EXISTS (SELECT 1 FROM scm.hr_item_kpi WHERE company_id IS NULL) THEN ALTER TABLE scm.hr_item_kpi ALTER COLUMN company_id SET NOT NULL; END IF; ALTER TABLE scm.hr_item_kpi DROP CONSTRAINT IF EXISTS hr_item_kpi_company_id_fkey; ALTER TABLE scm.hr_item_kpi ADD CONSTRAINT hr_item_kpi_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_hr_item_kpi_company_id ON scm.hr_item_kpi (company_id); END IF; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_salesperson_profiles' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.hr_salesperson_profiles ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.hr_salesperson_profiles SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; IF NOT EXISTS (SELECT 1 FROM scm.hr_salesperson_profiles WHERE company_id IS NULL) THEN ALTER TABLE scm.hr_salesperson_profiles ALTER COLUMN company_id SET NOT NULL; END IF; ALTER TABLE scm.hr_salesperson_profiles DROP CONSTRAINT IF EXISTS hr_salesperson_profiles_company_id_fkey; ALTER TABLE scm.hr_salesperson_profiles ADD CONSTRAINT hr_salesperson_profiles_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_hr_salesperson_profiles_company_id ON scm.hr_salesperson_profiles (company_id); END IF; END $$;

-- 4) hr_salesperson_profiles: one profile per (company, staff) ---------------
-- 0089 already converts a bare UNIQUE(staff_id) -> UNIQUE(company_id, staff_id)
-- dynamically. This re-asserts the END STATE only, for the case where 0089's
-- guard skipped the table: drop any unique on exactly [staff_id], then add the
-- composite. Same constraint NAME as 0089 and as step 2, so all three paths
-- converge on one identity and this block is a no-op once satisfied.

DO $$ DECLARE r record; BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='hr_salesperson_profiles' AND c.relkind IN ('r','p')) AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='scm' AND table_name='hr_salesperson_profiles' AND column_name='company_id') AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hr_salesperson_profiles_company_staff_unique') THEN FOR r IN SELECT ci.relname AS idxname, con.conname AS conname FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_class ci ON ci.oid = i.indexrelid LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid WHERE n.nspname='scm' AND t.relname='hr_salesperson_profiles' AND i.indisunique AND NOT i.indisprimary AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attnum = ANY(i.indkey)) = ARRAY['staff_id'] LOOP IF r.conname IS NOT NULL THEN EXECUTE 'ALTER TABLE scm.hr_salesperson_profiles DROP CONSTRAINT ' || quote_ident(r.conname); ELSE EXECUTE 'DROP INDEX scm.' || quote_ident(r.idxname); END IF; END LOOP; ALTER TABLE scm.hr_salesperson_profiles ADD CONSTRAINT hr_salesperson_profiles_company_staff_unique UNIQUE (company_id, staff_id); END IF; END $$;

-- 5) hr_commission_config: retire the id=1 singleton -------------------------
-- Drop 2990's CHECK (id = 1) if this DB has it (the export does not, a
-- 0171-shaped DB does). Matched on the DEFINITION, not a guessed constraint
-- name, and narrowly (`id = 1`) so no unrelated CHECK is collateral.

DO $$ DECLARE r record; BEGIN FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'scm.hr_commission_config'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%id = 1%' LOOP EXECUTE 'ALTER TABLE scm.hr_commission_config DROP CONSTRAINT ' || quote_ident(r.conname); END LOOP; END $$;

-- id becomes an ordinary surrogate off a sequence (the export left it
-- `DEFAULT 1`, which would collide the moment a second company is seeded).
CREATE SEQUENCE IF NOT EXISTS scm.hr_commission_config_id_seq OWNED BY scm.hr_commission_config.id;

-- is_called=false when the table is empty so the first nextval yields 1;
-- otherwise resume past the highest existing id.
SELECT setval('scm.hr_commission_config_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM scm.hr_commission_config), 1), (SELECT COALESCE(MAX(id), 0) FROM scm.hr_commission_config) > 0);

ALTER TABLE scm.hr_commission_config ALTER COLUMN id SET DEFAULT nextval('scm.hr_commission_config_id_seq');

-- company_id is the real identity now.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hr_commission_config_company_unique') THEN ALTER TABLE scm.hr_commission_config ADD CONSTRAINT hr_commission_config_company_unique UNIQUE (company_id); END IF; END $$;

-- 6) seed one config row per company ----------------------------------------
-- The seed the 2990 export dropped. Rate columns come from their DEFAULTs —
-- identical to what 2990's 0171 seeded, so Houzs pays exactly what 2990 pays
-- until someone deliberately edits the rates. Every company gets a row: a
-- company without one would leave /hr/config with no honest answer to return.
-- WHERE NOT EXISTS keeps re-runs (and future companies) safe.

INSERT INTO scm.hr_commission_config (company_id)
SELECT c.id FROM public.companies c
WHERE NOT EXISTS (SELECT 1 FROM scm.hr_commission_config h WHERE h.company_id = c.id);

-- 7) read paths -------------------------------------------------------------
-- /hr/commission filters profiles by (company_id, active) and item-KPI flags by
-- (company_id, active) on every payout run. Both tables are small, but the
-- composite keeps the plan honest as profiles grow.

CREATE INDEX IF NOT EXISTS idx_hr_salesperson_profiles_company_active ON scm.hr_salesperson_profiles (company_id, active);

CREATE INDEX IF NOT EXISTS idx_hr_item_kpi_company_active ON scm.hr_item_kpi (company_id, active);
