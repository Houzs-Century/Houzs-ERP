-- 20261102T1700_scm_saved_locations.sql
-- A saved "common locations" address book (owner 2026-11-02, 方案2) so a TRANSFER
-- DP order's origin and destination can be PICKED from a kept list instead of
-- typed every time — customers, suppliers, outsourced warehouses, frequent points.
--
-- WHY. 方案1 (mig 20261102T1500) let a transfer pick from/to as our warehouse or a
-- 3PL. The next step the owner asked for: pre-store the points you deliver between
-- and pick them once. This adds that master, and two soft-link refs on dp_orders
-- so a job records WHICH saved location its origin / destination came from.
--
-- MULTI-COMPANY. Tenant-scoped like scm.threepl_companies (mig 0210): company_id
-- BIGINT NOT NULL REFERENCES public.companies(id); the route scopes every read and
-- write to the active company. Natural key (company_id, name).
--
-- The dp_orders refs are BARE columns, no FK — the same soft-link decision 0129 /
-- 0251 / 20261102T1300 / 20261102T1500 made: a DP order keeps its snapshot and
-- must survive the saved location being edited or removed.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill. RE-CHECK THE
-- NUMBER AT MERGE.
--
-- REVERSAL:
--   ALTER TABLE scm.dp_orders
--     DROP COLUMN IF EXISTS saved_location_id,
--     DROP COLUMN IF EXISTS from_saved_location_id;
--   DROP TABLE IF EXISTS scm.saved_locations;

CREATE TABLE IF NOT EXISTS scm.saved_locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL REFERENCES public.companies(id),
  name          TEXT NOT NULL,
  contact_name  TEXT NULL,
  contact_phone TEXT NULL,
  address1      TEXT NULL,
  address2      TEXT NULL,
  city          TEXT NULL,
  postcode      TEXT NULL,
  state         TEXT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT NULL,
  created_by    UUID NULL,
  updated_by    UUID NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT saved_locations_name_uq UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_saved_locations_company
  ON scm.saved_locations (company_id, is_active);

-- The DP order -> saved-location soft links (destination + origin). NULL when the
-- side was a warehouse / 3PL / typed address rather than a picked saved location.
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS saved_location_id      uuid;
ALTER TABLE scm.dp_orders ADD COLUMN IF NOT EXISTS from_saved_location_id uuid;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role, like the
-- rest of the scm board config.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.saved_locations TO service_role;
  END IF;
END
$grant$;

-- Let PostgREST see the new table without a manual reload.
NOTIFY pgrst, 'reload schema';
