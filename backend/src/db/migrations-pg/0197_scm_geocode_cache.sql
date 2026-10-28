-- 0197_scm_geocode_cache.sql — GEOCODE CACHE for the TMS Phase 3 scheduler.
--
-- WHY. The "Propose times + route" action turns each delivery stop's free-text
-- address (scm.mfg_sales_orders.address1/2 + postcode + state) into a lat/lng so
-- the Distance Matrix can measure travel time between stops. Geocoding is a PAID
-- Google call; the SAME address is scheduled over and over (repeat customers,
-- re-planned trips), so a given normalized address must geocode exactly ONCE and
-- then be served from this table forever. Mirrors how maps.ts gates routing on
-- the key: nothing bills that a cache hit can answer.
--
-- NOT COMPANY SCOPED. An address resolves to the same point on Earth regardless
-- of which company is delivering there, so the cache is global (one row per
-- normalized address). The normalized key strips case / punctuation / repeated
-- whitespace (see geocode.ts normalizeAddress) so trivial spelling variants of
-- the same address share one row.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, no runtime
-- self-apply. pg-migrate runs the whole file in one transaction.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.geocode_cache (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The lookup key: lower-cased, punctuation-stripped, whitespace-collapsed
  -- address (geocode.ts normalizeAddress). UNIQUE so a repeat address is a hit.
  normalized_address  TEXT NOT NULL,
  -- The raw address the geocode was requested for (kept for debugging / audit).
  raw_address         TEXT NOT NULL,
  -- Google's own cleaned address string (formatted_address), for display.
  formatted_address   TEXT NULL,
  lat                 DOUBLE PRECISION NOT NULL,
  lng                 DOUBLE PRECISION NOT NULL,
  -- Google's geocode precision (ROOFTOP / RANGE_INTERPOLATED / GEOMETRIC_CENTER /
  -- APPROXIMATE), so a low-confidence hit can be surfaced or re-geocoded later.
  location_type       TEXT NULL,
  geocoded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT geocode_cache_normalized_uq UNIQUE (normalized_address)
);
