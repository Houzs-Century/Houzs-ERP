-- ----------------------------------------------------------------------------
-- 0175 — Canonical Malaysian state vocabulary.
--
-- Owner 2026-07-22 (Sales Order list showed "Pulau Pinang" and "PENANG" side
-- by side): the PMS surfaces store an UPPERCASE list of 16 short codes
-- (JOHOR / KL / PENANG / N.S. / …), while the SCM surfaces store the Title
-- Case names from `scm.my_localities` (Johor / Kuala Lumpur / Pulau Pinang /
-- Negeri Sembilan / …). Any cross-module report bucketing on `state` splits
-- the same physical state into two buckets.
--
-- The canonical vocabulary is the one stored in `scm.my_localities` (~5,870
-- rows seeded from Pos Malaysia's postcode dataset). It is:
--
--    Johor / Kedah / Kelantan / Kuala Lumpur / Labuan / Melaka /
--    Negeri Sembilan / Pahang / Perak / Perlis / Pulau Pinang /
--    Putrajaya / Sabah / Sarawak / Selangor / Terengganu
--
-- This migration is the DATA half:
--   1. Ship a SQL function `scm.canonicalize_my_state(text) → text` so the
--      backend + future migrations can canonicalize consistently.
--   2. Backfill every state column that is not already canonical, on the
--      Malaysia rows. Foreign strings (China provinces, SG regions) are left
--      untouched — the function returns the input unchanged when it doesn't
--      recognise it.
--   3. Rewrite `scm.upsert_customer_by_name_phone` if present so it applies
--      the canonicalizer at write time (defensive — the backend also does it).
--
-- What we DO NOT do here:
--   * Add a CHECK constraint or FK to `scm.my_localities.state`. Historical
--     rows for OTHER countries (China, Singapore) legitimately hold values
--     outside the MY list; enforcing at the schema level would require a
--     compound (state, country) FK we don't have yet.
--   * Touch `scm.state_delivery_regions.state_key` — that column is already a
--     canonical key by construction (its writers picked from the my_localities
--     dropdown) and any dirty row there would break delivery routing, not
--     just labelling. If dirty rows exist, they'll surface in the post-
--     migration compare workflow and get their own targeted fix.
-- ----------------------------------------------------------------------------

-- ── 1. Canonical mapper function ────────────────────────────────────────────
-- Idempotent: applying to an already-canonical string returns it unchanged.
-- Returns the input untouched for NULL / empty / unrecognised strings so it
-- can be applied to any address column without corrupting foreign values.
CREATE OR REPLACE FUNCTION scm.canonicalize_my_state(input text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  norm text;
BEGIN
  IF input IS NULL THEN RETURN NULL; END IF;
  norm := btrim(input);
  IF norm = '' THEN RETURN input; END IF;

  -- Fast path: already canonical.
  IF norm IN (
    'Johor','Kedah','Kelantan','Kuala Lumpur','Labuan','Melaka',
    'Negeri Sembilan','Pahang','Perak','Perlis','Pulau Pinang',
    'Putrajaya','Sabah','Sarawak','Selangor','Terengganu'
  ) THEN
    RETURN norm;
  END IF;

  -- Match case- and separator-insensitively against every historical spelling.
  -- Normalise the key: uppercase, REPLACE dots with a space (not drop them),
  -- then collapse whitespace. Dot-to-space is what makes 'P.PINANG',
  -- 'P. PINANG' and 'P PINANG' all collapse to the same key. Keep in sync
  -- with `probeKey` in backend/src/scm/lib/canonical-state.ts.
  norm := upper(norm);
  norm := replace(norm, '.', ' ');
  norm := regexp_replace(norm, '\s+', ' ', 'g');
  norm := btrim(norm);

  RETURN CASE norm
    -- PMS UPPERCASE list (Projects.tsx PROJECT_STATES / ProjectMaintenance MY_STATES).
    WHEN 'JOHOR'            THEN 'Johor'
    WHEN 'KEDAH'            THEN 'Kedah'
    WHEN 'KELANTAN'         THEN 'Kelantan'
    WHEN 'KL'               THEN 'Kuala Lumpur'
    WHEN 'KUALA LUMPUR'     THEN 'Kuala Lumpur'
    WHEN 'WP KUALA LUMPUR'  THEN 'Kuala Lumpur'
    WHEN 'W P KUALA LUMPUR' THEN 'Kuala Lumpur'
    WHEN 'WILAYAH PERSEKUTUAN KUALA LUMPUR' THEN 'Kuala Lumpur'
    WHEN 'LABUAN'           THEN 'Labuan'
    WHEN 'WP LABUAN'        THEN 'Labuan'
    WHEN 'W P LABUAN'       THEN 'Labuan'
    WHEN 'MELAKA'           THEN 'Melaka'
    WHEN 'MALACCA'          THEN 'Melaka'
    WHEN 'NEGERI SEMBILAN'  THEN 'Negeri Sembilan'
    WHEN 'NS'               THEN 'Negeri Sembilan'
    WHEN 'N S'              THEN 'Negeri Sembilan'
    WHEN 'N SEMBILAN'       THEN 'Negeri Sembilan'
    WHEN 'PAHANG'           THEN 'Pahang'
    WHEN 'PENANG'           THEN 'Pulau Pinang'
    WHEN 'PULAU PINANG'     THEN 'Pulau Pinang'
    WHEN 'P PINANG'         THEN 'Pulau Pinang'
    WHEN 'PERAK'            THEN 'Perak'
    WHEN 'PERLIS'           THEN 'Perlis'
    WHEN 'PUTRAJAYA'        THEN 'Putrajaya'
    WHEN 'WP PUTRAJAYA'     THEN 'Putrajaya'
    WHEN 'W P PUTRAJAYA'    THEN 'Putrajaya'
    WHEN 'SABAH'            THEN 'Sabah'
    WHEN 'SARAWAK'          THEN 'Sarawak'
    WHEN 'SELANGOR'         THEN 'Selangor'
    WHEN 'TERENGGANU'       THEN 'Terengganu'
    WHEN 'TRENGGANU'        THEN 'Terengganu'
    -- Unknown / foreign — return the ORIGINAL string, not the uppercase probe.
    ELSE input
  END;
END $$;

-- ── 2. Data backfill ────────────────────────────────────────────────────────
-- Each block is guarded by `to_regclass` so a missing table (test env) does
-- not fail the migration. Only rows where canonicalize_my_state() ACTUALLY
-- differs are touched — foreign rows / already-canonical rows are skipped.
DO $$
BEGIN
  -- public.projects (PMS) — this is the largest UPPERCASE source.
  IF to_regclass('public.projects') IS NOT NULL THEN
    UPDATE public.projects p
       SET state = scm.canonicalize_my_state(p.state)
     WHERE p.state IS NOT NULL
       AND p.state <> scm.canonicalize_my_state(p.state);
  END IF;

  -- public.project_venues (VenueManager) — same UPPERCASE bucket as projects.
  IF to_regclass('public.project_venues') IS NOT NULL THEN
    UPDATE public.project_venues v
       SET state = scm.canonicalize_my_state(v.state)
     WHERE v.state IS NOT NULL
       AND v.state <> scm.canonicalize_my_state(v.state);
  END IF;

  -- scm.suppliers / scm.customers — the country filter was defence-in-depth
  -- against corrupting a foreign state name, but `canonicalize_my_state()`
  -- already returns its input UNCHANGED when the value isn't a recognised MY
  -- state (see the ELSE branch above). So the country filter is redundant —
  -- and, critically, `scm.customers` HAS NO COUNTRY COLUMN. The original
  -- version of this migration failed on `column c.country does not exist`,
  -- which blocked pg-migrate for every subsequent file (mig 0176 region seed,
  -- the sales-order concurrency migrations pending after that) — main went
  -- red on 2026-07-22. Drop the filter; the function's own foreign-safe
  -- ELSE branch is the actual protection.
  IF to_regclass('scm.suppliers') IS NOT NULL THEN
    UPDATE scm.suppliers s
       SET state = scm.canonicalize_my_state(s.state)
     WHERE s.state IS NOT NULL
       AND s.state <> scm.canonicalize_my_state(s.state);
  END IF;

  IF to_regclass('scm.customers') IS NOT NULL THEN
    UPDATE scm.customers c
       SET state = scm.canonicalize_my_state(c.state)
     WHERE c.state IS NOT NULL
       AND c.state <> scm.canonicalize_my_state(c.state);
  END IF;

  -- Every document that carries a customer_state snapshot: SO / DO / SI / CO /
  -- CN / CR / DR. Loop by name so a missing table is a no-op. ALSO guard on
  -- the customer_state column existing per-table — some of the historical
  -- doc-tables (consignment_notes / delivery_returns / mfg_so_amendments)
  -- may not have that column even though the table itself exists. The
  -- deploy on 2026-07-23 00:47 UTC failed on exactly this class:
  --   `FAILED 0175: column "customer_state" does not exist`
  -- Same fix pattern as the earlier customers.country hotfix — `to_regclass`
  -- protects against a missing TABLE; `information_schema.columns` is what
  -- protects against a missing COLUMN.
  DECLARE
    t text;
    schema_part text;
    table_part text;
  BEGIN
    FOREACH t IN ARRAY ARRAY[
      'scm.mfg_sales_orders',
      'scm.mfg_delivery_orders',
      'scm.mfg_sales_invoices',
      'scm.consignment_orders',
      'scm.consignment_notes',
      'scm.consignment_returns',
      'scm.delivery_returns',
      'scm.mfg_so_amendments'
    ]
    LOOP
      IF to_regclass(t) IS NULL THEN CONTINUE; END IF;
      schema_part := split_part(t, '.', 1);
      table_part  := split_part(t, '.', 2);
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = schema_part
           AND table_name   = table_part
           AND column_name  = 'customer_state'
      ) THEN CONTINUE; END IF;
      EXECUTE format(
        $upd$
          UPDATE %s
             SET customer_state = scm.canonicalize_my_state(customer_state)
           WHERE customer_state IS NOT NULL
             AND customer_state <> scm.canonicalize_my_state(customer_state)
        $upd$, t);
    END LOOP;
  END;

  -- Delivery-planning orders (0129) carry both `state` and `customer_state`.
  -- Same per-column presence check — dp_orders may exist without one of them
  -- in a partial-migration environment.
  IF to_regclass('scm.dp_orders') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='scm' AND table_name='dp_orders' AND column_name='state'
    ) THEN
      UPDATE scm.dp_orders
         SET state = scm.canonicalize_my_state(state)
       WHERE state IS NOT NULL
         AND state <> scm.canonicalize_my_state(state);
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='scm' AND table_name='dp_orders' AND column_name='customer_state'
    ) THEN
      UPDATE scm.dp_orders
         SET customer_state = scm.canonicalize_my_state(customer_state)
       WHERE customer_state IS NOT NULL
         AND customer_state <> scm.canonicalize_my_state(customer_state);
    END IF;
  END IF;
END $$;
