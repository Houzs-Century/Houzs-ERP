-- 0100_pos_cart.sql — company_id scope for scm.pos_carts (issue #385).
--
-- Port of the 2990's /pos-cart endpoint into the Houzs merged backend. The
-- salesperson's live in-progress POS cart lives DB-side (scm.pos_carts) so it
-- follows them across devices and does NOT bleed to the next person on a shared
-- tablet. The table itself already exists on prod from the scm schema import
-- (backend/scripts/scm-schema/2990s-full-schema.sql, keyed by staff_id uuid),
-- but migration 0089 DELIBERATELY left it unstamped (it was grouped with the
-- per-staff reference tables). Issue #385 reverses that for the merged backend:
-- carts must be company-scoped so the ported route can filter/stamp company_id
-- (company_2 = 2990 in the POS context) like every other per-company module.
--
-- This migration is ADDITIVE, idempotent and re-run-safe:
--   • CREATE SCHEMA / TABLE IF NOT EXISTS — no-op on prod (already imported),
--     but makes a fresh DB / staging without the 2990 import valid.
--   • company_id added NULLABLE (no NOT NULL backfill step) so it can never
--     fail on prod — the scoping helpers (scm/lib/companyScope.ts) already
--     no-op on a NULL/unresolved company, and the ported route stamps
--     company_id on the next write-through.
--
-- Houzs CI auto-applies migrations-pg on every deploy; the runner splits on
-- ';\n', so each guarded block stays on ONE line (mirrors 0089).

CREATE SCHEMA IF NOT EXISTS scm;

CREATE TABLE IF NOT EXISTS scm.pos_carts (
  staff_id        uuid PRIMARY KEY NOT NULL,
  lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_quote_id text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Additive company_id stamp (nullable; FK -> public.companies; indexed). Guarded
-- on the table existing + being a real relation so the file is safe on any of
-- prod / staging / a fresh DB (mirrors the 0089 relkind guard).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='pos_carts' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.pos_carts ADD COLUMN IF NOT EXISTS company_id bigint; ALTER TABLE scm.pos_carts DROP CONSTRAINT IF EXISTS pos_carts_company_id_fkey; ALTER TABLE scm.pos_carts ADD CONSTRAINT pos_carts_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_pos_carts_company_id ON scm.pos_carts (company_id); END IF; END $$;
