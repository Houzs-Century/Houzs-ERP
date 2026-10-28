-- ----------------------------------------------------------------------------
-- 20260911T1730 — de-duplicate scm.my_localities and lock it with a unique key.
--
-- The Malaysian postcode reference was seeded TWICE into a table whose only key
-- is its uuid PK, so every MY postcode carried two byte-identical rows. Measured
-- on prod (anogrigyjbduyzclzjgn) 2026-09-11: 5,866 MY rows for 2,929 distinct
-- postcodes; 5,973 rows total including the once-seeded CN/SG set (mig 0181,
-- INSERT ... WHERE NOT EXISTS, so NOT doubled). The UI hid it — the cascade
-- option lists collapse through a Set — so the only cost paid was ~0.9 MB of
-- duplicate reference data on every cold GET /api/scm/localities. Full trace:
-- docs/bugs/0816-scm-my-localities-was-seeded-twice-so-every-malaysian-postco.md.
--
-- Two statements, one transaction (pg-migrate.mjs wraps each file):
--
--   1. Collapse to one row per (country, state, city, postcode). Per key, keep
--      the row that carries a warehouse_id override (a defensive tie-break — a
--      dedupe must never drop the city-level delivery-routing override; there
--      are none today, rows_with_warehouse_override = 0) else the lowest id.
--      Proven safe BEFORE writing this: no (country,state,city,postcode) group
--      varies by state_code or warehouse_id (variance = 0) and there are no
--      null/blank core fields, so nothing but an exact duplicate is removed.
--      Row count 5,973 -> 3,040, where 3,040 = distinct (country,state,city,
--      postcode) measured on the same connection.
--
--   2. Add the UNIQUE index the table never had. This is the ROOT fix: the
--      double-seed was possible only because no constraint existed (the route
--      header and mig 0181 both note the absence). With it, a re-run of any
--      seed FAILS LOUDLY instead of silently doubling the set again — the
--      behaviour CLAUDE.md's Migrations section wants ("DUPLICATE ... are what
--      break it"). POST /localities maps the 23505 this can raise to a 409.
--
-- Runs against staging + prod alike; both carry the same double-seed.
--
-- REVERSAL: DROP INDEX IF EXISTS scm.my_localities_country_state_city_postcode_key;
--   the row de-duplication is IRREVERSIBLE and harmless to leave undone — each
--   removed row was byte-identical to the kept one, so no information is lost.
-- Verified against: prod anogrigyjbduyzclzjgn, 2026-09-11 (row counts above).
-- ----------------------------------------------------------------------------

DELETE FROM scm.my_localities t
 USING (
   SELECT id,
          row_number() OVER (
            PARTITION BY country, state, city, postcode
            ORDER BY (warehouse_id IS NOT NULL) DESC, id
          ) AS rn
     FROM scm.my_localities
 ) ranked
 WHERE t.id = ranked.id
   AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS my_localities_country_state_city_postcode_key
    ON scm.my_localities (country, state, city, postcode);
