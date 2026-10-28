-- ----------------------------------------------------------------------------
-- 0180 — Warehouse structured address: state / postcode / city columns.
--
-- Owner 2026-07-23: "warehouse location 换成 address 模式". Warehouse today
-- carries a single free-text `location` field ("Address / area"). Every
-- delivery-planning read that wants "which state does this warehouse serve"
-- has to string-match location. Cross-report bucketing by warehouse state
-- doesn't work.
--
-- Add the same three canonical address columns the rest of the address
-- surfaces use — `state` (canonical from scm.my_localities, per mig 0175),
-- `postcode` (5-digit MY), `city` (from my_localities cascade). `location`
-- STAYS as-is for backward compat (freeform street/area line the operator
-- may still fill), so nothing that reads it today breaks.
--
-- Backfill: derive state from each row's `code` prefix, since the current
-- naming pattern (PG WAREHOUSE / KL WAREHOUSE / SBH WAREHOUSE / SRW
-- WAREHOUSE / CHINA WAREHOUSE / etc.) encodes the state. Rows we can't map
-- from code (HQ, C&C K.J, showrooms with venue names) are left NULL — the
-- Warehouse Maintenance UI lets the operator pick from the canonical
-- dropdown to fill them in.
--
-- No CHECK constraint or FK to my_localities.state: the backend write path
-- runs `canonicalizeMyState()` at ingress (per mig 0175 pattern), and a
-- warehouse might legitimately be foreign (CHINA WAREHOUSE = 'Guangdong'
-- or similar) — CHECK-constraining to the 16 MY states would break that.
-- ----------------------------------------------------------------------------

ALTER TABLE scm.warehouses ADD COLUMN IF NOT EXISTS country  text;
ALTER TABLE scm.warehouses ADD COLUMN IF NOT EXISTS state    text;
ALTER TABLE scm.warehouses ADD COLUMN IF NOT EXISTS postcode text;
ALTER TABLE scm.warehouses ADD COLUMN IF NOT EXISTS city     text;

-- Backfill state from the code prefix, on rows still NULL. Idempotent: any
-- row that already has state (a follow-up edit, or a re-run) is untouched.
UPDATE scm.warehouses SET state = CASE
  WHEN code ILIKE 'KL %'    OR code = 'KL WAREHOUSE'    OR code = 'KL DISPLAY' OR code = 'KL SERVICE'
                                                        THEN 'Kuala Lumpur'
  WHEN code ILIKE 'PG %'    OR code IN ('PG WAREHOUSE','PG DISPLAY','PG SERVICE')
                                                        THEN 'Pulau Pinang'
  WHEN code ILIKE 'PJ %'    OR code = 'PJ SHOWROOM'     THEN 'Selangor'
  WHEN code ILIKE 'SLGR %'  OR code = 'SLGR WAREHOUSE'  THEN 'Selangor'
  WHEN code ILIKE 'SBH %'   OR code IN ('SBH WAREHOUSE','SBH DISPLAY')
                                                        THEN 'Sabah'
  WHEN code ILIKE 'SRW %'   OR code = 'SRW WAREHOUSE'   THEN 'Sarawak'
  WHEN code ILIKE 'SRK %'   OR code = 'SRK WAREHOUSE'   THEN 'Sarawak'
  WHEN code ILIKE 'KELANA%'                             THEN 'Selangor'
  WHEN code ILIKE 'SUNWAY%'                             THEN 'Selangor'
  WHEN code ILIKE 'C&C%'                                THEN 'Selangor'
  WHEN code ILIKE 'EM %'    OR code = 'EM DISPLAY'      THEN 'Selangor'
  WHEN code ILIKE 'CHINA%'                              THEN 'Guangdong'
  ELSE state
END
WHERE state IS NULL;

-- Backfill country from state via my_localities. Idempotent — only fills
-- NULL, leaves anything the operator has already picked untouched. Rows
-- whose state isn't in my_localities (HQ, C&C K.J, unknown) stay NULL and
-- the operator fills via the drawer.
UPDATE scm.warehouses w
   SET country = COALESCE((
         SELECT ml.country FROM scm.my_localities ml
          WHERE ml.state = w.state
          LIMIT 1
       ), w.country)
 WHERE w.country IS NULL AND w.state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warehouses_state   ON scm.warehouses (state);
CREATE INDEX IF NOT EXISTS idx_warehouses_country ON scm.warehouses (country);
