-- 20261128T0100_scm_packing_scan_sets.sql
--
-- WHY. The packing list's QR ("SCAN WHEN FULLY LOADED", owner 2026-11-27) marks
-- every delivery order on the sheet Loaded. Its token lived on scm.trips (mig
-- 0329), but on production customer DOs are almost never on trips: a DO's lorry
-- is its Delivery Planning crew plate (scm.delivery_order_crew.lorry_plate). A
-- sheet per lorry per delivery day had no row to carry a token, so it could not
-- print a working QR.
--
-- A ROW = ONE PRINTED SHEET: the company, the lorry plate and delivery date it
-- was printed for, and the delivery orders printed on it, in sheet order. The
-- scan moves only those DOs, and leaves alone (and reports) one whose crew plate
-- has changed since printing, so a DO moved to another lorry is never loaded
-- from the wrong sheet. Re-printing the same set returns the same token.
--
-- TOKEN: same shape, same lazily-minted credential and same kill switch
-- (qr_revoked_at) as scm.delivery_orders / scm.trips (migs 0328 / 0329); the
-- UNIQUE PARTIAL index is the tenancy control: a token resolves to one row and
-- that row's company_id is the whole scope of the public scan.
--
-- company_id is bigint because public.companies.id is bigint (mig 0083).
-- No backfill, no data: rows are created when a sheet is printed.
-- RE-CHECK THE NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.packing_scan_sets;
--   Dropping it kills the QR on every packing list printed by lorry and day
--   (the paper keeps a token no row carries); recovery is to re-print.

CREATE TABLE IF NOT EXISTS scm.packing_scan_sets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     BIGINT NOT NULL REFERENCES public.companies(id),
  lorry_plate    TEXT NOT NULL,
  delivery_date  DATE NOT NULL,
  do_ids         UUID[] NOT NULL,
  qr_token       TEXT NOT NULL,
  qr_revoked_at  TIMESTAMPTZ NULL,
  created_by     UUID NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT packing_scan_sets_plate_nonblank CHECK (btrim(lorry_plate) <> ''),
  CONSTRAINT packing_scan_sets_has_dos CHECK (cardinality(do_ids) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_packing_scan_sets_qr_token
  ON scm.packing_scan_sets (qr_token);
CREATE INDEX IF NOT EXISTS idx_packing_scan_sets_sheet
  ON scm.packing_scan_sets (company_id, delivery_date, lorry_plate);

-- Like every scm table (mig 0061): RLS on with no policy, so only the service
-- role the Worker uses reads or writes it.
ALTER TABLE scm.packing_scan_sets ENABLE ROW LEVEL SECURITY;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.packing_scan_sets TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.packing_scan_sets IS
  'One printed packing list per lorry and delivery day: the DOs printed on it and its public scan token. '
  'The scan marks those DOs Loaded. See scm/lib/lorry-day-scan.ts.';

-- Let PostgREST see the new table without a manual reload.
NOTIFY pgrst, 'reload schema';
