-- 0101_quotes.sql — create the scm.quotes table on PROD (issue #386). The
-- ported route (backend/src/scm/routes/quotes.ts → /api/scm/quotes) saves a POS
-- cart as an OPEN quote (not yet promoted to an order). 2990 has `public.quotes`
-- but the Houzs scm schema never got it — 0083 carries a GUARDED stamp block for
-- scm.quotes (IF EXISTS ...) that no-op'd on prod because the table was absent.
-- Without this table the /quotes route 500s at runtime.
--
-- DDL derived from the 2990 source (packages/db/migrations/0000 §quotes, cross-
-- checked against scripts/scm-schema/2990s-full-schema.sql). Houzs port
-- conventions (mirror 0081/0090):
--   * schema-qualified to scm.*; NO inner BEGIN/COMMIT (pg-migrate owns the
--     transaction); every DO $$ ... $$ block on ONE line (the ';\n' splitter).
--   * created_by kept uuid but NO FK to scm.staff (0081/0090 precedent — the
--     SCM auth bridge pins every caller to the seeded system-staff uuid).
--   * showroom_id made NULLABLE and left unused: 2990's showroom resolution is
--     POS-staff-specific (staff.showroom_id + elevated-role fallback) and does
--     not translate to the Houzs pinned system-staff bridge. company_id scoping
--     replaces showroom-based isolation. Column kept (nullable) so the wire
--     shape still carries `showroom_id`.
--   * promoted_to_order_id kept text, NO FK (conservative — the Houzs SO id
--     space differs; the route only filters IS NULL on it).
--   * company_id bigint NOT NULL + FK public.companies + index from day one
--     (0083 already carries a guarded stamp block for scm.quotes, which no-op'd
--     on prod; the drift block at the bottom re-runs that stamp for any DB —
--     e.g. staging — where the table pre-exists without company_id).
--   * RLS stripped (Houzs guards in the route + area-guard + service-role key).
--
-- Idempotent + re-run-safe: CREATE TABLE/INDEX IF NOT EXISTS throughout; the
-- drift block ADDs company_id only where missing, so the file is a no-op on any
-- DB where scm.quotes already exists with company_id.

-- 1. QUOTES (clone of 2990 public.quotes; company-scoped) ---------------------
CREATE TABLE IF NOT EXISTS scm.quotes (
  id                   text PRIMARY KEY,
  company_id           bigint NOT NULL REFERENCES public.companies(id),
  showroom_id          uuid,
  created_by           uuid NOT NULL,
  customer_name        text NOT NULL,
  customer_phone       text,
  customer_email       text,
  cart                 jsonb NOT NULL,
  addons               jsonb,
  subtotal             integer NOT NULL,
  addon_total          integer NOT NULL DEFAULT 0,
  total                integer NOT NULL,
  pricing_version      text NOT NULL,
  expires_at           timestamptz,
  promoted_to_order_id text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quotes_created_by ON scm.quotes (created_by);
CREATE INDEX IF NOT EXISTS idx_quotes_company_id ON scm.quotes (company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_open ON scm.quotes (created_at DESC) WHERE promoted_to_order_id IS NULL;

-- 2. DRIFT: stamp company_id on any pre-existing scm.quotes (e.g. staging) -----
-- Mirrors the 0083 guarded block; no-op where the CREATE above already added it.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='scm' AND c.relname='quotes' AND c.relkind IN ('r','p')) THEN ALTER TABLE scm.quotes ADD COLUMN IF NOT EXISTS company_id bigint; UPDATE scm.quotes SET company_id = (SELECT id FROM public.companies WHERE code = 'HOUZS') WHERE company_id IS NULL; ALTER TABLE scm.quotes ALTER COLUMN company_id SET NOT NULL; ALTER TABLE scm.quotes DROP CONSTRAINT IF EXISTS quotes_company_id_fkey; ALTER TABLE scm.quotes ADD CONSTRAINT quotes_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id); CREATE INDEX IF NOT EXISTS idx_quotes_company_id ON scm.quotes (company_id); END IF; END $$;
