-- ----------------------------------------------------------------------------
-- 0159 — Reconcile the Delivery Planning region config to the 5 GEOGRAPHIC
-- buckets prod was hand-set to on 2026-07-21, so a fresh env / DB reset seeds
-- the SAME shape instead of migration 0053's older 6-region set.
--
-- Background: delivery-planning is a CROSS-COMPANY shared board — loadRegionConfig
-- (scm/routes/delivery-planning.ts) reads scm.delivery_planning_regions UNSCOPED,
-- so there must be exactly ONE clean set of buckets. 0053 seeded a 6-region
-- geographic set (SELANGOR/KL/NORTHERN/SOUTHERN/EAST_COAST/EAST_MY); the owner
-- later hand-built a KL/PENANG/EM/SG set under 2990, and the two collided into
-- 10 tabs with a duplicate KL and every state double-mapped. Prod was reconciled
-- by hand to 5 buckets; this migration makes that the seeded default.
--
-- Target (owner decision): Klang Valley (KL) / Northern / Southern / East Coast /
-- East Malaysia (EM). Singapore folds into Southern (goods route via the Johor
-- transporter warehouse), so there is no standalone SG tab. Codes EM/SG are
-- load-bearing — the board's cross-border columns + dashed styling key off them —
-- so East Malaysia stays code EM, not the geographic EAST_MY.
--
-- Anchored to the HOUZS base company (same idiom as 0083's company_id backfill),
-- which ALSO re-homes the prod rows that were hand-created under 2990. Idempotent
-- and convergent: upsert the 5 targets, drop everything else, rebuild one region
-- per state — so re-running (or applying to any prior state) lands here exactly.
-- Fails safe to a no-op if the HOUZS company is somehow absent.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  co_id bigint;
BEGIN
  SELECT id INTO co_id FROM public.companies WHERE code = 'HOUZS' ORDER BY id LIMIT 1;
  IF co_id IS NULL THEN
    RAISE NOTICE '0159 skipped: HOUZS base company not present';
    RETURN;
  END IF;

  -- 1) Ensure the 5 target buckets exist on HOUZS (upsert by (company_id, code)).
  INSERT INTO scm.delivery_planning_regions (company_id, code, name, sort_order, active) VALUES
    (co_id, 'KL',         'Klang Valley',  10, true),
    (co_id, 'NORTHERN',   'Northern',      20, true),
    (co_id, 'SOUTHERN',   'Southern',      30, true),
    (co_id, 'EAST_COAST', 'East Coast',    40, true),
    (co_id, 'EM',         'East Malaysia', 50, true)
  ON CONFLICT (company_id, code) DO UPDATE
    SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, active = true;

  -- 2) Remove every other region — the old SELANGOR/EAST_MY seed buckets on
  --    HOUZS AND the KL/PENANG/EM/SG set hand-created under 2990 (any company).
  --    state_delivery_regions rows cascade via the FK (ON DELETE CASCADE).
  DELETE FROM scm.delivery_planning_regions
  WHERE NOT (company_id = co_id AND code IN ('KL','NORTHERN','SOUTHERN','EAST_COAST','EM'));

  -- 3) Rebuild the per-state mapping: exactly ONE region per state, on HOUZS.
  --    Singapore (country=Singapore) → Southern. Blank/unmapped states fall back
  --    to KL at read time (stateToRegionsFromConfig / FALLBACK_DEFAULT_REGION).
  DELETE FROM scm.state_delivery_regions;
  INSERT INTO scm.state_delivery_regions (company_id, state_key, country, region_id)
  SELECT co_id, v.state_key, v.country, r.id
  FROM (VALUES
    ('Selangor','Malaysia','KL'),
    ('Putrajaya','Malaysia','KL'),
    ('Kuala Lumpur','Malaysia','KL'),
    ('WP Kuala Lumpur','Malaysia','KL'),
    ('W.P. Kuala Lumpur','Malaysia','KL'),
    ('Pulau Pinang','Malaysia','NORTHERN'),
    ('Penang','Malaysia','NORTHERN'),
    ('Kedah','Malaysia','NORTHERN'),
    ('Perlis','Malaysia','NORTHERN'),
    ('Perak','Malaysia','NORTHERN'),
    ('Johor','Malaysia','SOUTHERN'),
    ('Melaka','Malaysia','SOUTHERN'),
    ('Malacca','Malaysia','SOUTHERN'),
    ('Negeri Sembilan','Malaysia','SOUTHERN'),
    ('Singapore','Singapore','SOUTHERN'),
    ('Pahang','Malaysia','EAST_COAST'),
    ('Terengganu','Malaysia','EAST_COAST'),
    ('Kelantan','Malaysia','EAST_COAST'),
    ('Sabah','Malaysia','EM'),
    ('Sarawak','Malaysia','EM'),
    ('Labuan','Malaysia','EM'),
    ('W.P. Labuan','Malaysia','EM')
  ) AS v(state_key, country, code)
  JOIN scm.delivery_planning_regions r ON r.code = v.code AND r.company_id = co_id;
END $$;
