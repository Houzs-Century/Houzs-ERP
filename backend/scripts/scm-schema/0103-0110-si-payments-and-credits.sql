-- ----------------------------------------------------------------------------
-- SI port — two backing tables the live `scm` schema is MISSING.
--
-- The 2990's full-schema export baked into apply-scm-schema.mjs predates the
-- Sales Invoice rebuild (2990 migrations 0103 / 0110), so the live `scm` schema
-- already has the rebuilt sales_invoices / sales_invoice_items columns (62 / 29
-- cols, verified via information_schema) but NOT these two tables:
--
--   • scm.sales_invoice_payments  — the SI payments ledger (POST/GET/DELETE
--     /sales-invoices/:id/payments, recomputePaid, applyCustomerCreditToSi).
--   • scm.customer_credits        — the customer credit-balance ledger that the
--     SI create / cancel / overpay paths write to (best-effort calls).
--
-- DDL is 2990's migrations 0103 (payments) + 0110 (credits), re-targeted to the
-- `scm` schema and with RLS / public-schema policies dropped (the scm routes use
-- the service-role client; Houzs gates /api/scm at the app layer). Idempotent.
--
-- NOT APPLIED automatically — review then run against DATABASE_URL, e.g. via a
-- one-off node script mirroring scripts/scm-schema/apply-scm-views.mjs, or paste
-- into the Supabase SQL editor. Until applied, the SI payments endpoints and the
-- best-effort customer-credit calls will 500 / error (the credit calls are
-- wrapped best-effort, so SI create still succeeds; payments do not).
-- ----------------------------------------------------------------------------

BEGIN;

-- ── sales_invoice_payments (2990 mig 0103) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS scm.sales_invoice_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_invoice_id    uuid NOT NULL REFERENCES scm.sales_invoices(id) ON DELETE CASCADE,
  paid_at             date NOT NULL DEFAULT CURRENT_DATE,
  method              text NOT NULL,                 -- 'merchant' | 'transfer' | 'cash' | 'installment' | 'credit'
  merchant_provider   text,
  installment_months  integer,
  online_type         text,
  approval_code       text,
  amount_centi        integer NOT NULL CHECK (amount_centi >= 0),
  account_sheet       text,
  collected_by        uuid REFERENCES scm.staff(id) ON DELETE SET NULL,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES scm.staff(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sip_si      ON scm.sales_invoice_payments(sales_invoice_id);
CREATE INDEX IF NOT EXISTS idx_sip_paid_at ON scm.sales_invoice_payments(paid_at);

-- ── customer_credits (2990 mig 0110) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scm.customer_credits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debtor_code        text NOT NULL,
  debtor_name        text,
  entry_date         date NOT NULL DEFAULT CURRENT_DATE,
  amount_centi       integer NOT NULL,              -- signed: + adds, − applies
  source_type        text NOT NULL,                 -- SI_CANCEL_REFUND | OVERPAY | APPLIED_TO_SI | MANUAL_ADJUST
  source_doc_no      text,
  source_doc_id      uuid,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES scm.staff(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cust_credits_debtor  ON scm.customer_credits(debtor_code);
CREATE INDEX IF NOT EXISTS idx_cust_credits_src     ON scm.customer_credits(source_type, source_doc_no);
CREATE INDEX IF NOT EXISTS idx_cust_credits_created ON scm.customer_credits(created_at DESC);

CREATE OR REPLACE VIEW scm.v_customer_credit_balances AS
SELECT
  debtor_code,
  MAX(debtor_name)  AS debtor_name,
  SUM(amount_centi) AS balance_centi,
  COUNT(*)          AS entry_count,
  MAX(created_at)   AS last_entry_at
FROM scm.customer_credits
GROUP BY debtor_code;

COMMIT;
