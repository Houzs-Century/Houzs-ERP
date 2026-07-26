-- 0210_scm_threepl_companies.sql — WS4a: 3PL carrier COMPANY master + lorry link.
--
-- WHY. Owner: a 3PL is a COMPANY that owns several lorries. Register the company
-- once, attach its lorries to it, and (WS4b) price by company instead of by each
-- individual lorry. A solo operator is a one-lorry company. Today an outsourced
-- lorry is just an OUTSOURCE row in scm.lorries with no company above it — this
-- adds that missing layer.
--
-- Two additive things:
--   1. scm.threepl_companies — the carrier company master (per tenant company).
--   2. scm.lorries.threepl_company_id — the lorry -> carrier-company link
--      (nullable; own-fleet and not-yet-attached lorries leave it NULL).
--
-- The rate card moves from per-lorry to per-company in WS4b; this migration lays
-- the master + link it will key on. Driver/helper company links follow when their
-- UI does — not added blind here.
--
-- MULTI-COMPANY. scm.threepl_companies is tenant-scoped like the other scm
-- masters: company_id BIGINT NOT NULL REFERENCES public.companies(id). "company"
-- here is overloaded: company_id = the Houzs TENANT; the row itself = a 3PL vendor.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS), schema-qualified, one
-- transaction. RE-CHECK THE NUMBER AT MERGE — 0210 was next free above 0209.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.threepl_companies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    BIGINT NOT NULL REFERENCES public.companies(id),
  name          TEXT NOT NULL,
  contact_name  TEXT NULL,
  contact_phone TEXT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT NULL,
  created_by    UUID NULL,
  updated_by    UUID NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT threepl_companies_name_uq UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_threepl_companies_company
  ON scm.threepl_companies (company_id, is_active);

-- The lorry -> carrier-company link. NULL for own-fleet / not-yet-attached.
-- ON DELETE SET NULL so removing a company DETACHES its lorries, never deletes them.
ALTER TABLE scm.lorries
  ADD COLUMN IF NOT EXISTS threepl_company_id UUID NULL
    REFERENCES scm.threepl_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lorries_threepl_company
  ON scm.lorries (threepl_company_id);
