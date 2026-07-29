-- ----------------------------------------------------------------------------
-- 0229 — Canonical venue name, enforced at the DATABASE.
--
-- WHY. The same physical showroom kept re-appearing under two names ("PJ
-- Showroom" vs "2990s PJ") in the Projects "By Venue" P&L and the SO surfaces.
-- It has now been cleaned THREE times: `unify-2990-venue-name.mjs` (#1155, the
-- SO/showroom side), `fair-pnl/standardize-venues.mjs` (#1310, the PMS side),
-- and `backfill-canonicalize-venue.mjs` (2026-07-29, all four surfaces). The
-- first two drifted straight back because a one-shot backfill installs no
-- guard. 2026-07-29 added the TS front door — `canonicalizeVenue()` in
-- backend/src/scm/lib/canonical-venue.ts, applied at createProject/patchProject,
-- the picker POST /venues, and resolveVenueBinding — but that entry recorded its
-- own gap out loud: "No SQL-level safety net ... a raw INSERT that bypasses the
-- service/resolver would still drift."
--
-- This is that net. Same shape as the `canonicalize_my_state` precedent
-- (mig 0175, a `scm.canonicalize_*()` mapper) plus the BEFORE-write trigger
-- precedent (mig 0186, `trg_warehouse_sync_is_showroom`): the mapper is the
-- vocabulary, the triggers make every code path go through it — scripts,
-- psql, a future migration, a route that forgets to import the helper.
--
-- ⚠️ KEEP IN SYNC — three copies of one map, by design:
--      backend/src/scm/lib/canonical-venue.ts   (runtime front door)
--      backend/scripts/backfill-canonicalize-venue.mjs   (one-shot cleanup)
--      scm.canonicalize_venue() below           (the net)
--    A divergence between them is EXACTLY the bug class this migration exists
--    to kill — the TS and SQL maps disagreeing would re-create the two-names
--    problem from the inside. backend/tests/venueCanonicalSql.test.ts fails the
--    build if the TS map gains an alias this file does not carry.
--
-- What this does NOT do:
--   * NO data backfill. The trigger fires on WRITE, never retroactively.
--     Existing rows are the job of `backfill-canonicalize-venue.mjs` +
--     `canonicalize-venue.yml` (DRY-RUN gated), which already exists and has
--     its own merge/duplicate-picker handling. Re-folding the same rows from a
--     migration would duplicate that logic in a place with no dry run.
--   * NO blank-filling. NULL stays NULL and '' stays '' — the owner asked to
--     unify the PJ alias, NOT to assign a venue to unassigned rows.
--   * NO CHECK constraint / FK to a venue vocabulary. Venue is legitimately
--     free text (every roadshow hall is a one-off); only KNOWN aliases fold.
-- ----------------------------------------------------------------------------

-- ── 1. The mapper ───────────────────────────────────────────────────────────
-- Idempotent: canonicalize(canonicalize(x)) = canonicalize(x).
-- NULL -> NULL, blank -> returned UNCHANGED (never turned into NULL, so a
-- NOT NULL column cannot be broken by this). An unrecognised venue comes back
-- trimmed but otherwise untouched, matching canonicalizeVenue() in the TS
-- module — we unify known aliases only, we do not invent a vocabulary.
CREATE OR REPLACE FUNCTION scm.canonicalize_venue(input text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  trimmed text;
  k text;
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  trimmed := btrim(input);
  IF trimmed = '' THEN RETURN input; END IF;

  -- The lookup key, byte-for-byte the same rule as `venueKey()` in
  -- canonical-venue.ts: lower-case, trimmed, inner whitespace collapsed.
  k := lower(regexp_replace(trimmed, '\s+', ' ', 'g'));

  RETURN CASE k
    -- canonical "2990s PJ"
    WHEN 'pj showroom' THEN '2990s PJ'
    WHEN 'pj-showroom' THEN '2990s PJ'
    WHEN 'pjshowroom'  THEN '2990s PJ'
    WHEN '2990s pj'    THEN '2990s PJ'
    WHEN '2990spj'     THEN '2990s PJ'
    WHEN '2990 pj'     THEN '2990s PJ'
    WHEN '2990pj'      THEN '2990s PJ'
    -- Unknown venue: trimmed, otherwise unchanged.
    ELSE trimmed
  END;
END $$;

-- ── 2. Per-table trigger functions ──────────────────────────────────────────
-- One tiny function per column rather than a generic TG_ARGV/jsonb rewriter:
-- the assignment is then correct by inspection, which matters because this
-- cannot be executed against Postgres from the branch that writes it.
CREATE OR REPLACE FUNCTION scm.projects_canonicalize_venue() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.venue := scm.canonicalize_venue(NEW.venue);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION scm.project_venues_canonicalize_name() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.name := scm.canonicalize_venue(NEW.name);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION scm.mfg_sales_orders_canonicalize_venue() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.venue := scm.canonicalize_venue(NEW.venue);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION scm.warehouses_canonicalize_venue_name() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.venue_name := scm.canonicalize_venue(NEW.venue_name);
  RETURN NEW;
END $$;

-- ── 3. Attach ───────────────────────────────────────────────────────────────
-- Guarded per TABLE (to_regclass) *and* per COLUMN (information_schema), the
-- lesson mig 0175 learned the expensive way: `to_regclass` protects against a
-- missing table, and a missing COLUMN on a present table is a different failure
-- that took main red on 2026-07-23 ("column customer_state does not exist").
-- A migration that fails here blocks every later one, and none of these columns
-- were created by a numbered migration in this tree (project_venues arrived
-- with the D1 -> Supabase import), so presence is checked, never assumed.
--
-- DROP + CREATE (not CREATE OR REPLACE, which triggers do not support) makes
-- the attach idempotent, exactly as mig 0186 does.
DO $$
DECLARE
  spec text[];
  t text;
  c text;
  fn text;
  trg text;
  schema_part text;
  table_part text;
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    -- table, venue column, trigger function
    ARRAY['public.projects',       'venue',      'scm.projects_canonicalize_venue'],
    ARRAY['public.project_venues', 'name',       'scm.project_venues_canonicalize_name'],
    ARRAY['scm.mfg_sales_orders',  'venue',      'scm.mfg_sales_orders_canonicalize_venue'],
    ARRAY['scm.warehouses',        'venue_name', 'scm.warehouses_canonicalize_venue_name']
  ]
  LOOP
    t  := spec[1];
    c  := spec[2];
    fn := spec[3];
    IF to_regclass(t) IS NULL THEN CONTINUE; END IF;
    schema_part := split_part(t, '.', 1);
    table_part  := split_part(t, '.', 2);
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = schema_part
         AND table_name   = table_part
         AND column_name  = c
    ) THEN CONTINUE; END IF;

    trg := 'trg_' || table_part || '_canonicalize_' || c;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trg, t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %s
         FOR EACH ROW EXECUTE FUNCTION %s()',
      trg, c, t, fn
    );
  END LOOP;
END $$;

-- project_venues.name is UNIQUE (case-insensitive) in the D1 original. Where the
-- live Postgres table kept that constraint, a raw INSERT of an ALIAS while the
-- canonical picker row already exists now raises unique_violation instead of
-- quietly adding the second menu entry. That loud refusal is the intent: the
-- app path never reaches it, because POST /venues canonicalizes first and
-- reactivates the existing canonical row (routes/projects.ts).

-- ── 4. Tables deliberately NOT covered ──────────────────────────────────────
-- `public.sales_orders.venue` — the AutoCount mirror. Its writer is the sync,
--   and rewriting a mirrored value makes the mirror disagree with the system of
--   record it exists to reflect; drift detection there compares against
--   AutoCount, not against us.
-- `public.sales_entries.venue` — neither prior backfill nor the TS front door
--   touches it. Canonicalizing it HERE and nowhere else would put the SQL net
--   and the TS map out of step in the opposite direction, which is the failure
--   this migration is about. If that surface needs folding it takes its own
--   change to all three copies of the map at once.
-- `scm.venues` / `scm.mfg_sales_orders.venue_id` — id references, not names;
--   they cannot drift by spelling. Merging duplicate picker ROWS stays the
--   backfill script's opt-in MERGE_PICKER path (it repoints FKs, which a
--   write-time trigger must never do).
