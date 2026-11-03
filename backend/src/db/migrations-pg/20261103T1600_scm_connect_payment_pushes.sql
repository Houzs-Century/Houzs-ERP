-- 20261103T1600_scm_connect_payment_pushes.sql
-- REVERSAL: DROP TABLE IF EXISTS scm.connect_payment_pushes;
--   Revert the code first (routes/connect-payments.ts reads and writes it).
--   Payments already booked from a push stay — they are ordinary
--   scm.mfg_sales_order_payments rows; only the push ledger goes.
--   GRANTS: none to re-apply — the table rides the scm schema's default
--   privileges (service_role), like scm.so_payment_backdate_requests.
--
-- WHAT THIS CHANGES, and why it is safe to run against production: one new empty
-- table and its indexes; no existing row is written or altered.
--
-- WHY. HOUZS CONNECT (the WhatsApp CRM) confirms a customer's payment slip and
-- PUSHES it to the ERP at POST /api/connect/payments (reuses the CONNECT_SERVICE_TOKEN
-- service auth). This table is that push's IDEMPOTENCY LEDGER and its
-- MANUAL-LINK QUEUE in one:
--   · connect_payment_id is Connect's own id for the confirmed payment and is
--     UNIQUE here — a retry of the same id returns the first outcome and never
--     books a second mfg_sales_order_payments row.
--   · a push whose order_ref does not resolve to exactly one Sales Order (or
--     whose slip date is outside the 14-day window, or whose bank / online
--     sub-type is not in the live so_dropdown_options) is NOT booked blind — it
--     lands here at status 'needs_manual' for a human to link, with the slip
--     already stored in R2 (slip_key) and the full push kept in payload.
--   status  processing -> recorded | needs_manual | failed
--     recorded      -> erp_payment_id links the booked scm.mfg_sales_order_payments row
--     needs_manual  -> order_ref/phone/amount/slip_key carry what a human needs to link it
--     failed        -> a transient error; the same connect_payment_id may be retried
--
-- Plain CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, schema-qualified,
-- no DO block (pg-migrate splits on ";\n"), no enum (a text CHECK is reversible).

CREATE TABLE IF NOT EXISTS scm.connect_payment_pushes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connect_payment_id  text NOT NULL,
  company_id          bigint,
  status              text NOT NULL DEFAULT 'processing'
                      CHECK (status IN ('processing', 'recorded', 'needs_manual', 'failed')),
  so_doc_no           text,
  erp_payment_id      uuid,
  order_ref           text,
  customer_phone      text,
  customer_name       text,
  amount_sen          bigint NOT NULL CHECK (amount_sen > 0),
  currency            text,
  method              text,
  bank                text,
  online_type         text,
  installment_months  integer,
  approval_code       text,
  reference           text,
  paid_at             text,
  slip_key            text,
  error               text,
  payload             jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connect_payment_pushes_connect_payment_id_unique UNIQUE (connect_payment_id)
);

-- The manual-link queue reads "everything still needing a human" per company,
-- newest first; the partial predicate keeps it tiny once most rows are 'recorded'.
CREATE INDEX IF NOT EXISTS idx_connect_payment_pushes_needs_manual
  ON scm.connect_payment_pushes (company_id, created_at DESC)
  WHERE status = 'needs_manual';

-- Trace a booked ERP payment back to the push it came from.
CREATE INDEX IF NOT EXISTS idx_connect_payment_pushes_erp_payment
  ON scm.connect_payment_pushes (erp_payment_id);
