-- 0029_scm_seed_full_maintenance_config.sql — seed the sofaCompartmentMeta map
-- on the master maintenance-config blob so the "Sofa Compartments" tab can show
-- a per-compartment description + default price (and is photo-ready), and so the
-- master config carries the same OPTIONAL meta key 2990's evolved config carries.
--
-- WHY THIS EXISTS (read before extending):
--   The owner wants Houzs's furniture Maintenance to match 2990's PRODUCTION
--   config. 2990's prod values evolved at RUNTIME via the Maintenance UI (the
--   gaps/divanHeights/legHeights counts the owner sees on 2990 differ from BOTH
--   the 0039 baseline AND Houzs's live config) and those edited values live ONLY
--   in 2990's live Supabase DB. That DB is NOT reachable from this environment —
--   2990 keeps no local .dev.vars / DATABASE_URL and applies migrations via the
--   Supabase MCP. So 2990's *evolved* priced-pool values could NOT be ported
--   here; doing so blindly would invent prices. This migration therefore seeds
--   ONLY what is derivable from canonical, in-repo Houzs data:
--     • sofaCompartmentMeta — description + defaultPriceCenti sourced 1:1 from
--       scm.compartment_library (already seeded in 0022). NO imageKey is set:
--       compartment thumbnails are R2 objects under 2990's `2990s-so-item-photos`
--       bucket (sofaCompartmentMeta[code].imageKey = `sofa-compartments/<code>/
--       <uuid>.<ext>`), served via a proxy endpoint — they are NOT absolute URLs.
--       Porting the images = copying R2 objects into Houzs's own bucket; that is
--       a SEPARATE step (see the "R2 PHOTO PORT" note at the bottom) and is left
--       to the owner / a dedicated task. Until then commander can upload fresh
--       photos from the Sofa Compartments tab (POST .../sofa-compartments/:code/
--       photo) which writes imageKey into this same map.
--
--   NOT seeded here (deliberate):
--     • sizeLabels — bedframe/mattress size rows ALREADY display label +
--       dimensions via resolveSizeInfo()'s static SIZE_INFO fallback
--       (frontend/src/vendor/scm/lib/size-info.ts). sizeLabels is only a
--       commander RELABEL override; seeding it would create dirty diffs on every
--       Save with zero display benefit (same rationale as 0027).
--     • gaps / divanHeights / legHeights / totalHeights / sofaSizes / specials /
--       sofaSpecials / sofaLegHeights — Houzs already carries the full 0039
--       baseline for these (18 specials, 7 gaps, 10 divan, 6 leg, 10 total,
--       6 sofaSizes, 3 sofaSpecials, 3 sofaLegHeights). 2990's PROD numbers
--       diverge but are unknown from here, so they are intentionally untouched.
--       If the owner later supplies 2990's resolved blob (a paste from the
--       Supabase SQL editor, or restored 2990 DB access), a follow-up migration
--       can merge the real priced pools.
--
-- IDEMPOTENCY + owner-edit safety: the EXISTING config is on the RIGHT of the
-- jsonb `||` operator, so any key already present (incl. an owner's later
-- sofaCompartmentMeta edit or photo upload) WINS — only the ABSENT key gets the
-- seed. The WHERE clause additionally skips the row once sofaCompartmentMeta
-- exists, so a re-run writes nothing at all. Never clobbers commander edits.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT (pg-migrate
-- owns the txn); single statement (no internal ';\n' — the runner splits on
-- ";\n"). No unqualified enum casts, so no SET search_path needed.
UPDATE scm.maintenance_config_history
SET config = (
  $$
  {
    "sofaCompartmentMeta": {
      "1A(LHF)": { "description": "1A - Left hand facing",             "defaultPriceCenti": 149000 },
      "1A(RHF)": { "description": "1A - Right hand facing",            "defaultPriceCenti": 149000 },
      "1B(LHF)": { "description": "1B - Left hand facing (wide arm)",  "defaultPriceCenti": 149000 },
      "1B(RHF)": { "description": "1B - Right hand facing (wide arm)", "defaultPriceCenti": 149000 },
      "1NA":     { "description": "1NA - No arms",                     "defaultPriceCenti": 99000  },
      "2A(LHF)": { "description": "2A - Left hand facing",             "defaultPriceCenti": 199000 },
      "2A(RHF)": { "description": "2A - Right hand facing",            "defaultPriceCenti": 199000 },
      "2B(LHF)": { "description": "2B - Left hand facing (wide arm)",  "defaultPriceCenti": 199000 },
      "2B(RHF)": { "description": "2B - Right hand facing (wide arm)", "defaultPriceCenti": 199000 },
      "2NA":     { "description": "2NA - No arms",                     "defaultPriceCenti": 149000 },
      "CNR":     { "description": "Corner piece",                      "defaultPriceCenti": 149000 },
      "L(LHF)":  { "description": "L - Left hand facing chaise",       "defaultPriceCenti": 149000 },
      "L(RHF)":  { "description": "L - Right hand facing chaise",      "defaultPriceCenti": 149000 },
      "Console": { "description": "Wood console - 45cm",               "defaultPriceCenti": 59000  },
      "STOOL":   { "description": "Ottoman / stool",                   "defaultPriceCenti": 49000  }
    }
  }
  $$::jsonb || config
)
WHERE id = 'mch-baseline-master-001'
  AND scope = 'master'
  AND NOT (config ? 'sofaCompartmentMeta');

-- ============================================================================
-- R2 PHOTO PORT (SEPARATE STEP — NOT done by this migration)
-- ----------------------------------------------------------------------------
-- The Sofa Compartments thumbnails on 2990 are R2 objects in 2990's
-- `2990s-so-item-photos` bucket, keyed sofa-compartments/<code>/<uuid>.<ext>,
-- recorded as sofaCompartmentMeta[<code>].imageKey on 2990's master config row.
-- To show those SAME images on Houzs you must:
--   1. Copy each object from 2990's R2 bucket into Houzs's SO_ITEM_PHOTOS bucket
--      (same key prefix is fine — the proxy validates key-in-compartment-prefix).
--   2. Patch sofaCompartmentMeta[<code>].imageKey here to the copied key.
-- Both 2990 R2 access AND 2990's resolved imageKey values are required and are
-- NOT available from this environment. Easiest path: the owner re-uploads photos
-- from Houzs's Sofa Compartments tab (no R2 cross-account copy needed), which
-- writes imageKey into this map via POST .../sofa-compartments/:code/photo.
-- ============================================================================
