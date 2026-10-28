-- 0030_scm_align_hookka_maintenance.sql — align Houzs's master maintenance
-- config to HOOKKA's LIVE production values.
--
-- WHY THIS EXISTS:
--   The owner wants Houzs's furniture Maintenance pools to mirror HOOKKA's
--   real, in-production variant config. Unlike 2990 (whose evolved DB was
--   unreachable — see 0029's note), HOOKKA's live Postgres IS reachable
--   read-only, so the EXACT current arrays were read straight from HOOKKA and
--   are pasted verbatim below:
--     • HOOKKA  kv_config.value WHERE key='variants-config' — the master blob
--       carrying divanHeights / totalHeights / legHeights / gaps / sofaSizes /
--       sofaLegHeights / specials / sofaSpecials (each {value, priceSen}, a
--       few leg entries also carry an inert HOOKKA-only packSeparately bool).
--     • HOOKKA  products WHERE category='SOFA' — the 18 DISTINCT size_code
--       values ARE HOOKKA's sofa "compartments". (HOOKKA's category column is
--       a TEXT enum 'SOFA'/'BEDFRAME'/'ACCESSORY', not the integer 101 the
--       task guessed — category='SOFA' is the correct predicate and returns
--       all 18 codes.)
--
-- SHAPE — confirmed 1:1 against BOTH the Houzs frontend reader
-- (frontend/src/pages/scm-v2/Products.tsx + vendor/shared/mfg-pricing.ts /
-- maintenance-pools.ts) AND Houzs's own existing master row:
--   • Priced pools (divanHeights / totalHeights / legHeights / specials /
--     sofaLegHeights / sofaSpecials) are MfgPricedOption[] = {value, priceSen}
--     (priceSen = cents; costSen/sellingPriceSen are opt-in and intentionally
--     omitted so rows stay shape-identical to HOOKKA — "single price" per the
--     task). packSeparately is an unmodeled HOOKKA extra; Houzs references it
--     nowhere (grep-clean in apps/frontend + apps/backend) so it round-trips
--     harmlessly and is kept to make the values byte-exact to HOOKKA.
--   • String pools (gaps / sofaSizes) are MaintPoolEntry[] = plain strings (a
--     bare string IS the active entry). gaps are QUOTED inches ("4\""); sofaSizes
--     are bare numeric strings ("24") with NO inch suffix — matching HOOKKA and
--     Houzs's current row exactly.
--   • sofaCompartments stays a plain string[] of the 18 HOOKKA codes (per
--     PR #220: per-compartment meta lives in the parallel sofaCompartmentMeta
--     map, which the renderer reads as `config.sofaCompartmentMeta ?? {}`).
--   • sofaCompartmentMeta — per-code description (canonical Houzs taxonomy from
--     COMPARTMENT_DESCRIPTION_OVERRIDE; 3S/CSL/L added) with defaultPriceCenti
--     CLEARED to 0 on EVERY code (owner: sofa compartments have NO price), and
--     NO imageKey (HOOKKA stores no compartment photos).
--
-- THIS IS A HARD ALIGNMENT, NOT A SEED: unlike 0027/0029 (which used `seed ||
-- config` so existing keys win), this migration must REPLACE the listed keys
-- with HOOKKA's values, so the new blob is on the LEFT of `config || <new>`
-- (right side wins). Re-running is deterministic — it always re-asserts the
-- same HOOKKA values, so it is idempotent in effect (a second run is a no-op
-- diff). It DOES override prior owner edits to these specific pools by design:
-- the instruction is to adopt HOOKKA's values as the new baseline.
--
-- Houzs conventions: schema-qualified to scm.*; no inner BEGIN/COMMIT
-- (pg-migrate owns the txn); single statement (no internal ';\n' — the runner
-- splits on ";\n"). No unqualified enum casts, so no SET search_path needed.
UPDATE scm.maintenance_config_history
SET config = config || (
  $$
  {
    "divanHeights": [
      { "value": "4\"",  "priceSen": 0 },
      { "value": "5\"",  "priceSen": 0 },
      { "value": "6\"",  "priceSen": 0 },
      { "value": "8\"",  "priceSen": 0 },
      { "value": "10\"", "priceSen": 5500 },
      { "value": "11\"", "priceSen": 13000 },
      { "value": "12\"", "priceSen": 13000 },
      { "value": "13\"", "priceSen": 15000 },
      { "value": "14\"", "priceSen": 15000 },
      { "value": "16\"", "priceSen": 16000 }
    ],
    "totalHeights": [
      { "value": "25\"", "priceSen": 4000 },
      { "value": "23\"", "priceSen": 0 },
      { "value": "21\"", "priceSen": 0 },
      { "value": "19\"", "priceSen": 4000 },
      { "value": "18\"", "priceSen": 8000 },
      { "value": "20\"", "priceSen": 0 },
      { "value": "22\"", "priceSen": 0 },
      { "value": "24\"", "priceSen": 0 },
      { "value": "26\"", "priceSen": 8000 },
      { "value": "28\"", "priceSen": 16000 }
    ],
    "legHeights": [
      { "value": "No Leg", "priceSen": 0 },
      { "value": "1\"", "priceSen": 0 },
      { "value": "2\"", "priceSen": 0, "packSeparately": false },
      { "value": "4\"", "priceSen": 0, "packSeparately": false },
      { "value": "6\"", "priceSen": 0, "packSeparately": true },
      { "value": "7\"", "priceSen": 16000, "packSeparately": true },
      { "value": "5\"", "priceSen": 16000, "packSeparately": true }
    ],
    "gaps": ["4\"", "5\"", "6\"", "7\"", "8\"", "9\"", "10\"", "11\"", "12\"", "13\"", "14\"", "15\"", "16\""],
    "sofaSizes": ["24", "26", "28", "30", "32", "35"],
    "sofaLegHeights": [
      { "value": "No Leg", "priceSen": 0 },
      { "value": "4\"", "priceSen": 0, "packSeparately": true },
      { "value": "6\"", "priceSen": 0, "packSeparately": true },
      { "value": "1\"", "priceSen": 0 },
      { "value": "5\"", "priceSen": 0, "packSeparately": true }
    ],
    "specials": [
      { "value": "HB Fully Cover", "priceSen": 5000 },
      { "value": "Divan Top Fully Cover", "priceSen": 5000 },
      { "value": "Divan Full Cover", "priceSen": 8000 },
      { "value": "Left Drawer", "priceSen": 16000 },
      { "value": "Right Drawer", "priceSen": 16000 },
      { "value": "Front Drawer", "priceSen": 13000 },
      { "value": "HB Straight", "priceSen": 0 },
      { "value": "Divan Top(W)", "priceSen": 0 },
      { "value": "1 Piece Divan", "priceSen": 25000 },
      { "value": "Divan Curve", "priceSen": 5000 },
      { "value": "No Side Panel", "priceSen": -4000 },
      { "value": "Headboard Only", "priceSen": 0 },
      { "value": "Nylon Fabric", "priceSen": 0 },
      { "value": "5537 Backrest", "priceSen": 0 },
      { "value": "Add 1\" Infront L", "priceSen": 0 },
      { "value": "Separate Backrest Packing", "priceSen": 0 },
      { "value": "Divan A11", "priceSen": 0 },
      { "value": "Seat Add On 4\"", "priceSen": 0 }
    ],
    "sofaSpecials": [
      { "value": "Nylon Fabric", "priceSen": 0 },
      { "value": "5537 Backrest", "priceSen": 5000 },
      { "value": "Separate Backrest Packing", "priceSen": 0 },
      { "value": "Extend 5\"", "priceSen": 50000 },
      { "value": "Short Backrest", "priceSen": 0 },
      { "value": "Seat Add 1ft", "priceSen": 0 },
      { "value": "No bracket", "priceSen": 0 },
      { "value": "5540 Backrest", "priceSen": 5000 }
    ],
    "sofaCompartments": [
      "1A(LHF)", "1A(RHF)", "1B(LHF)", "1B(RHF)", "1NA", "1S",
      "2A(LHF)", "2A(RHF)", "2B(LHF)", "2B(RHF)", "2NA", "2S",
      "3S", "CNR", "CSL", "L(LHF)", "L(RHF)", "STOOL"
    ],
    "sofaCompartmentMeta": {
      "1A(LHF)": { "description": "1 seat, ONE arm (left)",  "defaultPriceCenti": 0 },
      "1A(RHF)": { "description": "1 seat, ONE arm (right)", "defaultPriceCenti": 0 },
      "1B(LHF)": { "description": "1 seat - LEFT is Seat Cushion (bench), no arm on the right", "defaultPriceCenti": 0 },
      "1B(RHF)": { "description": "1 seat - RIGHT is Seat Cushion (bench), no arm on the left", "defaultPriceCenti": 0 },
      "1NA":     { "description": "1 seat, NO arms",         "defaultPriceCenti": 0 },
      "1S":      { "description": "1 seat, arms on BOTH sides", "defaultPriceCenti": 0 },
      "2A(LHF)": { "description": "2 seats, ONE arm (left)",  "defaultPriceCenti": 0 },
      "2A(RHF)": { "description": "2 seats, ONE arm (right)", "defaultPriceCenti": 0 },
      "2B(LHF)": { "description": "2 seats - LEFT is Seat Cushion (bench), no arm on the right", "defaultPriceCenti": 0 },
      "2B(RHF)": { "description": "2 seats - RIGHT is Seat Cushion (bench), no arm on the left", "defaultPriceCenti": 0 },
      "2NA":     { "description": "2 seats, NO arms",        "defaultPriceCenti": 0 },
      "2S":      { "description": "2 seats, arms on BOTH sides", "defaultPriceCenti": 0 },
      "3S":      { "description": "3 seats, arms on BOTH sides", "defaultPriceCenti": 0 },
      "CNR":     { "description": "Corner piece - 90 degree L-shape connector", "defaultPriceCenti": 0 },
      "CSL":     { "description": "Chaise longue", "defaultPriceCenti": 0 },
      "L(LHF)":  { "description": "L-shape chaise - left hand facing",  "defaultPriceCenti": 0 },
      "L(RHF)":  { "description": "L-shape chaise - right hand facing", "defaultPriceCenti": 0 },
      "STOOL":   { "description": "Ottoman / stool", "defaultPriceCenti": 0 }
    }
  }
  $$::jsonb
)
WHERE id = 'mch-baseline-master-001'
  AND scope = 'master';
