-- 20261111T0400_acc_previous_payment_records.sql
--
-- WHY. Owner 2026-11-11: some money-in records are the previous system's — the
-- salesperson's payment records, the ones imported from AutoCount included:
-- 「我检查确定后，就直接说这个是之前record，我哪里都不会take-in」 and 「我说的是
-- sales man 的收款记录（包括imported from autocount)」. Houzs holds 2,799 imported
-- payments (2,670 dated before its books start) and 67 keyed here before the
-- books start; they sit on Payments not matched yet and on Merchant Recon's card
-- payments not reported yet, and are offered to its report lines.
--
-- One row per payment the owner has checked and marked (SOPAY = an order's
-- payment, SIPAY = an invoice's). A marked payment shows up nowhere a
-- reconciliation takes money in, and posts nothing (acc/previous-payments.ts).
-- A SEPARATE table, so the two payment tables and their many writers are
-- untouched. Undo deletes the row. Listed on Payments not matched yet as its
-- own list, apart from Merchant Recon's and Bank Recon's Set aside (owner: 要分开).
--
-- MULTI-COMPANY. company_id on every row; the route scopes reads and writes to
-- the active company. Natural key (company_id, payment_source, payment_id).
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified, no backfill. RE-CHECK THE
-- NUMBER AT MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.acc_previous_payment_records;

CREATE TABLE IF NOT EXISTS scm.acc_previous_payment_records (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES public.companies(id),
  payment_source  TEXT NOT NULL,
  payment_id      TEXT NOT NULL,
  marked_by       TEXT NULL,
  marked_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT acc_previous_payment_source CHECK (payment_source IN ('SOPAY', 'SIPAY')),
  CONSTRAINT acc_previous_payment_once UNIQUE (company_id, payment_source, payment_id)
);

CREATE INDEX IF NOT EXISTS idx_acc_previous_payment_records_company
  ON scm.acc_previous_payment_records (company_id);

ALTER TABLE scm.acc_previous_payment_records ENABLE ROW LEVEL SECURITY;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Read and written by the Worker through PostgREST as the service role, like the
-- rest of the acc tables.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, DELETE ON scm.acc_previous_payment_records TO service_role;
  END IF;
END
$grant$;

COMMENT ON TABLE scm.acc_previous_payment_records IS
  'Payments (SOPAY/SIPAY) the owner marked as the previous system''s records: shown on no '
  'reconciliation list, offered to no merchant or bank line, posting nothing. See acc/previous-payments.ts.';

-- Let PostgREST see the new table without a manual reload.
NOTIFY pgrst, 'reload schema';
