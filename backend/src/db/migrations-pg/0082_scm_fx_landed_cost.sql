-- 0082_scm_fx_landed_cost.sql — multi-currency FX + landed-cost backend, ported
-- from 2990 migrations 0188 (PI exchange_rate) + 0190 (GRN exchange_rate → MYR)
-- + 0191 (landed allocation_method + per-line allocated charge) + 0193 (currencies
-- master) into the scm schema. Phase 1-A backend.
--
-- THE MODEL (verbatim from 2990):
--   * A currency MASTER (scm.currencies) holds each currency's rate_to_myr; the
--     owner maintains it in the Maintenance page. MYR is the base — always rate 1.
--   * A GRN / PI / PV carries { currency, exchange_rate } = MYR per 1 unit of the
--     doc currency. MYR ⇒ rate 1, a strict NO-OP (round(x*1) === x): every
--     existing all-MYR Houzs row keeps its cost/GL byte-for-byte identical.
--   * GRN landed cost ("平摊"): a SERVICE line's freight is POOLED and allocated
--     across the goods lines (allocation_method QTY/VALUE/CBM) and folded into the
--     FIFO lot cost, stored per line as grn_items.allocated_charge_centi so a
--     later PI recost can re-add it. NO separate FX gain/loss GL account — the
--     document-time rate is the truth; the MYR-equivalent is what posts.
--
-- Houzs adaptation (mirrors migrations 0080 / 0081):
--   * schema-qualified to scm.*; SET search_path = scm, public.
--   * NO inner BEGIN/COMMIT — the pg-migrate runner owns ONE transaction.
--   * pg-migrate splits on /;\s*\n/ and does NOT respect $$; every DO $$ ... $$
--     block is therefore written ON ONE LINE (internal ';' space-separated).
--   * additive + run-once + IF NOT EXISTS / duplicate_object guards → re-run safe.
--   * company_id: plain NULLABLE bigint, NO foreign key + NO NOT-NULL (the
--     `companies` master doesn't exist until Phase 0f). stampCompany /
--     activeCompanyId(c) fill it once multi-company is active; a later 0f
--     migration can add the FK. The doc tables (grns / purchase_invoices) already
--     carry company_id from migration 0061 — only the NEW currencies master needs
--     it here.
--
-- ⚠️ Houzs CI auto-applies migrations-pg to PROD on deploy — this migration is
-- idempotent (IF NOT EXISTS + duplicate_object DO-guards) so a re-run is safe.
-- Apply BEFORE deploying the dependent API code (migrate-before-deploy).

SET search_path = scm, public;

-- ── Currency MASTER (2990 migration 0193) ───────────────────────────────────
-- Owner-maintained list + each currency's current rate to MYR. rate_to_myr must
-- be > 0 (a 0 rate would zero out the money path). MYR seeded at rate 1.
CREATE TABLE IF NOT EXISTS scm.currencies (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  symbol       text,
  rate_to_myr  numeric(14,6) NOT NULL DEFAULT 1,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  company_id   bigint
);
DO $$ BEGIN ALTER TABLE scm.currencies ADD CONSTRAINT currencies_rate_positive CHECK (rate_to_myr > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_currencies_company ON scm.currencies (company_id);
CREATE INDEX IF NOT EXISTS idx_currencies_active  ON scm.currencies (is_active);

-- Seed MYR (base) + the common foreign currencies at rate 1 (owner edits later).
-- ON CONFLICT DO NOTHING → re-run safe; never overwrites an owner-set rate.
INSERT INTO scm.currencies (code, name, symbol, rate_to_myr, is_active, sort_order) VALUES
  ('MYR', 'Malaysian Ringgit', 'RM', 1, true, 0),
  ('RMB', 'Chinese Yuan',      '¥',  1, true, 1),
  ('USD', 'US Dollar',         '$',  1, true, 2),
  ('SGD', 'Singapore Dollar',  'S$', 1, true, 3)
ON CONFLICT (code) DO NOTHING;

-- ── GRN: exchange_rate + allocation_method (2990 migrations 0190 + 0191) ─────
-- currency already exists on scm.grns (migration 0101); ensure its default.
DO $$ BEGIN ALTER TABLE scm.grns ALTER COLUMN currency SET DEFAULT 'MYR'; EXCEPTION WHEN undefined_column THEN NULL; END $$;
ALTER TABLE scm.grns ADD COLUMN IF NOT EXISTS exchange_rate numeric(14,6) NOT NULL DEFAULT 1;
DO $$ BEGIN CREATE TYPE scm.grn_allocation_method AS ENUM ('QTY', 'VALUE', 'CBM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE scm.grns ADD COLUMN IF NOT EXISTS allocation_method scm.grn_allocation_method NOT NULL DEFAULT 'QTY';

-- Per goods-line allocated freight (MYR sen), folded into the lot at receive time
-- and re-added on a PI recost. 0 everywhere ⇒ landed cost === base cost (no-op).
ALTER TABLE scm.grn_items ADD COLUMN IF NOT EXISTS allocated_charge_centi integer NOT NULL DEFAULT 0;

-- ── Purchase Invoice: exchange_rate (2990 migration 0188) ────────────────────
-- currency already exists on scm.purchase_invoices (migration 0101).
DO $$ BEGIN ALTER TABLE scm.purchase_invoices ALTER COLUMN currency SET DEFAULT 'MYR'; EXCEPTION WHEN undefined_column THEN NULL; END $$;
ALTER TABLE scm.purchase_invoices ADD COLUMN IF NOT EXISTS exchange_rate numeric(14,6) NOT NULL DEFAULT 1;

-- Per PI goods-line allocated freight (MYR sen) — PI-level landed freight (2990
-- migration 0202), separate from the GRN charge; each capitalises exactly once.
ALTER TABLE scm.purchase_invoice_items ADD COLUMN IF NOT EXISTS allocated_charge_centi integer NOT NULL DEFAULT 0;

-- NOTE: scm.payment_vouchers already carries currency + exchange_rate (migration
-- 0081) — left untouched here; the route now honours a foreign rate (Phase 1-A).
