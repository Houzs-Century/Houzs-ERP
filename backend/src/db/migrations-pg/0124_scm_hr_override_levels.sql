-- 0124: HR commission — recursive reporting-line override (owner ruling 2026-07-17).
--
-- NUMBERING: 0123 is used by THREE files already (scm_hr_commission,
-- scm_customers_company_scoped_uniques, scm_sync_config). The runner sorts by
-- filename and tracks each separately, so triple-0123 is not itself a bug, but
-- it makes "which 0123" ambiguous in every conversation. 0124 and 0125 were both
-- free at the time of writing and this pair takes them.
--
-- WHY
--   The owner's ruling, verbatim: "無限 讓我們自己add 按SO算".
--     · 無限            — unlimited depth
--     · 讓我們自己add    — he configures the levels himself
--     · 按SO算          — SO-driven (he settled the delivery/invoice question)
--   2990's model cannot express this. Its override is FLAT PER SHOWROOM: anyone
--   with tier='manager' earns override_base_bps on the WHOLE showroom's goods,
--   and there is no manager_id anywhere in the HR schema — there is no chain to
--   walk. Houzs has one (public.users.manager_id, already indexed since 0002),
--   and the house rule "reporting-to = FULL recursive downline, every module"
--   has never applied to commission. This is the table that makes it apply.
--
-- WHAT "無限" MEANS IN THE SCHEMA
--   Depth is bounded by the ROWS THE OWNER ADDS, not by any constant. There is
--   no max-level CHECK here. services/orgScope.ts's MAX_CHAIN_DEPTH = 10 is a
--   CYCLE bound, and routes/hr.ts passes it the deepest level actually
--   configured, so configuring a level 12 walks to 12. Nothing silently caps
--   what he called unlimited.
--
-- WHY PER-LEVEL AND NOT PER-POSITION
--   "讓我們自己add" is literally "let us add [them] ourselves" — rows you add.
--   A level is the natural unit of a reporting chain and needs exactly ONE
--   number, so the whole scheme is a short list he can read down. Per-POSITION
--   would need a position x level matrix (a Sales Manager at level 1 vs at
--   level 3), which is a second dimension he did not ask for and which has no
--   answer for a position that appears at two depths. He can tune the numbers,
--   add levels, or ask for a different shape.
--
-- NOTHING IS SEEDED, DELIBERATELY
--   An empty table is the honest state: the owner has not given a single level
--   rate yet, and inventing one would be inventing a payout. Combined with
--   override_mode defaulting to 'showroom' below, this file changes NOBODY's
--   commission on deploy. The mode flip is his switch, not the deploy's.
--
-- CONVENTIONS
--   timestamptz (not the 0008 text convention) — scm.* is natively PG and
--   written through PostgREST, matching 0123's reasoning. pg-migrate splits on
--   /;\s*\n/ BEFORE stripping comments, so every DO block is on ONE physical
--   line and no comment contains a semicolon.
-- ----------------------------------------------------------------------------

SET search_path = scm, public;

-- 1) the level table ---------------------------------------------------------
-- One editable rate per level, per company. level 1 = a person's DIRECT
-- reports, level 2 = their reports' reports, and so on up the chain.
-- `active` mirrors hr_item_kpi's pattern: switch a level off without losing the
-- rate you had tuned.

CREATE TABLE IF NOT EXISTS scm.hr_override_levels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level      integer NOT NULL,
  rate_bps   integer NOT NULL DEFAULT 0,
  label      text NOT NULL DEFAULT '',
  active     boolean NOT NULL DEFAULT true,
  company_id bigint NOT NULL REFERENCES public.companies(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT hr_override_levels_company_level_unique UNIQUE (company_id, level),
  CONSTRAINT hr_override_levels_level_min CHECK (level >= 1),
  CONSTRAINT hr_override_levels_rate_nonneg CHECK (rate_bps >= 0)
);

-- level 0 would be "an override on your OWN sale", i.e. paying someone twice for
-- one sale on top of their personal commission. The CHECK above makes that
-- unrepresentable rather than merely unlikely. There is deliberately no upper
-- bound on `level` — see "WHAT 無限 MEANS" above.

CREATE INDEX IF NOT EXISTS idx_hr_override_levels_company_active ON scm.hr_override_levels (company_id, active);

-- 2) the mode switch ---------------------------------------------------------
-- The two override models are MUTUALLY EXCLUSIVE and this column is what makes
-- that structural. Running both would pay a manager the flat showroom override
-- AND the chain override on overlapping goods — the exact double-pay the chain
-- model exists to end.
--
-- DEFAULT 'showroom' IS THE SAFETY PROPERTY, NOT A HEDGE. Defaulting to 'chain'
-- would, on the deploy that ships this file, switch every company to a scheme
-- with ZERO configured levels — every manager's override silently drops to
-- RM 0 on the next payout run. A silent payout change is precisely what this
-- work exists to prevent, so the default reproduces today's figures to the sen
-- and the owner flips the switch when his levels are in. (routes/hr.ts refuses
-- to compute 'chain' with no levels configured, so the drop cannot happen by
-- accident either way — this default means it cannot even be attempted.)

ALTER TABLE scm.hr_commission_config ADD COLUMN IF NOT EXISTS override_mode text NOT NULL DEFAULT 'showroom';

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='hr_commission_config_override_mode_check') THEN ALTER TABLE scm.hr_commission_config ADD CONSTRAINT hr_commission_config_override_mode_check CHECK (override_mode IN ('showroom', 'chain')); END IF; END $$;

-- 3) tier / showroom_id survive ----------------------------------------------
-- Not dropped, and this is a decision rather than an omission. A SHOWROOM IS A
-- PLACE, A REPORTING LINE IS A HIERARCHY — they are different dimensions and
-- the chain replaces only the OVERRIDE half of what tier/showroom_id drive:
--   · showroom_id still groups the report AND still supplies the RM 400k
--     showroom-KPI gate, which is a per-ROOM sales target and has nothing to do
--     with who reports to whom. Both modes read it identically.
--   · tier is no longer consulted for chain-mode override (having a downline is
--     what earns, not a flag) but still drives report display order and remains
--     2990's vocabulary for showroom mode, which stays live behind the switch.
-- So there is NO profile-row data migration in this file, and that is the point:
-- migrating live profile rows would be a staging-first data op, and nothing here
-- requires one.

-- 4) PostgREST schema cache ---------------------------------------------------
-- REQUIRED, not hygiene. /api/scm/* reads through PostgREST, which resolves
-- tables from a CACHED schema — a table created by a migration is invisible to
-- it until the cache reloads ("Could not find the table 'scm.<x>' in the schema
-- cache"). This repo has been bitten before and keeps the fix in
-- scripts/scm-schema/fix-scm-endpoint-drift.mjs ("Reload PostgREST so the FK
-- rename + new table hit the schema cache"), which is a MANUAL script nobody
-- will remember to run at deploy time. Without this, every /hr/override-levels
-- request 404s in prod while the migration reports success.
-- NOTIFY is delivered on COMMIT, so it fires only if this file actually applied.
NOTIFY pgrst, 'reload schema';
