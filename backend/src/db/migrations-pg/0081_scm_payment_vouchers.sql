-- 0081_scm_payment_vouchers.sql — port of 2990 migrations 0189 + 0202 into scm.
--
-- A Payment Voucher (PV) is a standalone AP cash-out document: pay a vendor that
-- is NOT a goods invoice (freight forwarder, one-off service). A PV carries a
-- payee + a credit account (the bank/cash/AP the money is paid FROM) + expense
-- lines (description + debit account + amount) + a total that posts to the GL:
--   Dr each line.debit_account_code  amount   (MYR)
--   Cr header.credit_account_code    Σ debits (MYR)
-- A SUPPLIER_PAYMENT PV can also SETTLE one or more Purchase Invoices at face
-- value (pv_allocations → decrements each PI's paid_centi on post).
--
-- Houzs adaptation (Phase 1-B, MYR-only):
--   * currency/exchange_rate columns are KEPT (2990 does FX) but default
--     'MYR' / 1 — no foreign-currency UI is built here (that is phase A).
--   * schema-qualified to scm.*; SET search_path = scm, public.
--   * NO inner BEGIN/COMMIT — the pg-migrate runner owns ONE transaction.
--   * pg-migrate splits on /;\s*\n/ and does NOT respect $$; every DO $$ ... $$
--     block is therefore written ON ONE LINE (internal ';' space-separated).
--   * RLS / is_staff() stripped (Houzs guards writes in the route + service-role
--     key). Additive + run-once + IF NOT EXISTS -> re-run safe.
--   * company_id: plain NULLABLE bigint, NO foreign key + NO NOT-NULL (the
--     `companies` master doesn't exist until Phase 0f). stampCompany /
--     activeCompanyId(c) fills it once multi-company is active; a later 0f
--     migration can add the FK. Mirrors mig 0080.
--
-- ⚠️ Houzs CI auto-applies migrations-pg to PROD on deploy — this migration is
-- idempotent (IF NOT EXISTS + duplicate_object DO-guards) so a re-run is safe.
--
-- Apply BEFORE deploying the dependent API code (migrate-before-deploy).

SET search_path = scm, public;

-- Enums ----------------------------------------------------------------------
DO $$ BEGIN CREATE TYPE scm.payment_voucher_status AS ENUM ('DRAFT', 'POSTED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE scm.payment_voucher_purpose AS ENUM ('SUPPLIER_PAYMENT', 'FREIGHT', 'OTHER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Header ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm.payment_vouchers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pv_number            text NOT NULL UNIQUE,
  voucher_date         date NOT NULL DEFAULT current_date,
  payee_name           text NOT NULL,
  supplier_id          uuid,
  credit_account_code  text NOT NULL,
  currency             text NOT NULL DEFAULT 'MYR',
  exchange_rate        numeric(14,6) NOT NULL DEFAULT 1,
  purpose              scm.payment_voucher_purpose NOT NULL DEFAULT 'SUPPLIER_PAYMENT',
  notes                text,
  total_centi          integer NOT NULL DEFAULT 0,
  status               scm.payment_voucher_status NOT NULL DEFAULT 'DRAFT',
  posted_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  company_id           bigint
);

-- Lines ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scm.payment_voucher_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pv_id                uuid NOT NULL,
  line_no              integer NOT NULL,
  description          text,
  debit_account_code   text NOT NULL,
  amount_centi         integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  company_id           bigint
);

-- PV -> PI settlement links --------------------------------------------------
-- amount_centi is the requested settle amount (PV/PI currency, face value);
-- applied_centi is what was actually added to the PI's paid_centi at post
-- (capped at the PI's outstanding then), so a cancel reverses exactly that.
CREATE TABLE IF NOT EXISTS scm.pv_allocations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pv_id         uuid NOT NULL,
  pi_id         uuid NOT NULL,
  amount_centi  bigint NOT NULL DEFAULT 0,
  applied_centi bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  company_id    bigint
);

-- Foreign keys (one-line DO guards; ADD CONSTRAINT is not IF-NOT-EXISTS-able) --
DO $$ BEGIN ALTER TABLE scm.payment_vouchers ADD CONSTRAINT payment_vouchers_supplier_id_fk FOREIGN KEY (supplier_id) REFERENCES scm.suppliers(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.payment_vouchers ADD CONSTRAINT payment_vouchers_credit_account_fk FOREIGN KEY (credit_account_code) REFERENCES scm.accounts(account_code) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.payment_vouchers ADD CONSTRAINT payment_vouchers_created_by_fk FOREIGN KEY (created_by) REFERENCES scm.staff(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.payment_voucher_lines ADD CONSTRAINT payment_voucher_lines_pv_id_fk FOREIGN KEY (pv_id) REFERENCES scm.payment_vouchers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.payment_voucher_lines ADD CONSTRAINT payment_voucher_lines_debit_account_fk FOREIGN KEY (debit_account_code) REFERENCES scm.accounts(account_code) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.pv_allocations ADD CONSTRAINT pv_allocations_pv_id_fk FOREIGN KEY (pv_id) REFERENCES scm.payment_vouchers(id) ON DELETE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE scm.pv_allocations ADD CONSTRAINT pv_allocations_pi_id_fk FOREIGN KEY (pi_id) REFERENCES scm.purchase_invoices(id) ON DELETE RESTRICT; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Indexes --------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_pv_date          ON scm.payment_vouchers (voucher_date);
CREATE INDEX IF NOT EXISTS idx_pv_supplier       ON scm.payment_vouchers (supplier_id);
CREATE INDEX IF NOT EXISTS idx_pv_status         ON scm.payment_vouchers (status);
CREATE INDEX IF NOT EXISTS idx_pv_company        ON scm.payment_vouchers (company_id);
CREATE INDEX IF NOT EXISTS idx_pv_lines_pv       ON scm.payment_voucher_lines (pv_id);
CREATE INDEX IF NOT EXISTS idx_pv_lines_company  ON scm.payment_voucher_lines (company_id);
CREATE INDEX IF NOT EXISTS idx_pv_alloc_pv       ON scm.pv_allocations (pv_id);
CREATE INDEX IF NOT EXISTS idx_pv_alloc_pi       ON scm.pv_allocations (pi_id);
CREATE INDEX IF NOT EXISTS idx_pv_alloc_company  ON scm.pv_allocations (company_id);
