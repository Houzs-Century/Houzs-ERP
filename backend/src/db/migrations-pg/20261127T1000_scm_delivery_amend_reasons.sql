-- 20261127T1000_scm_delivery_amend_reasons.sql — OWNER-MANAGED amend / postpone
-- reason list for Delivery Planning. These are the English phrases the board's
-- "Amend Reason" column offers, and the one the SO row carries becomes the
-- Postpone WhatsApp's "due to ..." reason (amend_date_reason_2 → Houzs Connect).
--
-- WHY A TABLE, NOT A CONSTANT. The reasons were a hardcoded array
-- (frontend AMEND_REASONS). The owner wants to add / edit / remove the options
-- themselves (owner 2026-11-27). This table holds that list; the board and the
-- Set-job-date drawer read it for their dropdown, and AMEND_REASONS stays only as
-- the offline fallback / seed. A reason already stored on an SO is plain text and
-- is unaffected when the list changes — the list only governs future picks.
--
-- MULTI-COMPANY. Scoped per company exactly like the other scm masters
-- (delivery_planning_regions, delivery_residence_rules): company_id NOT NULL,
-- per-company UNIQUE on (company_id, label) so each company keeps its own set.
--
-- CANONICAL SEED, NOT DEMO DATA. The seven existing AMEND_REASONS plus the new
-- public-holiday reason (owner 2026-11-27) — lookup/config rows that belong in a
-- numbered migration. Seeded for EVERY active company via a cross join so HOUZS
-- and 2990 (and any future company) start with the full, editable set. sort_order
-- is spaced by 10 so a new reason can slot between two without a renumber.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING),
-- schema-qualified, no runtime self-apply. pg-migrate runs the whole file in one
-- transaction.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.delivery_amend_reasons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  BIGINT NOT NULL REFERENCES public.companies(id),
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID NULL,
  updated_by  UUID NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_amend_reasons_company_label_uq UNIQUE (company_id, label)
);

CREATE INDEX IF NOT EXISTS idx_delivery_amend_reasons_company
  ON scm.delivery_amend_reasons (company_id);
CREATE INDEX IF NOT EXISTS idx_delivery_amend_reasons_active
  ON scm.delivery_amend_reasons (company_id, is_active);

-- Seed the canonical reason rows for EVERY active company. The first seven are
-- the existing AMEND_REASONS (unchanged order); the eighth is the new
-- public-holiday reason (owner 2026-11-27). All owner-editable afterwards.
INSERT INTO scm.delivery_amend_reasons (company_id, label, sort_order)
SELECT co.id, v.label, v.sort_order
FROM (VALUES
  ('Unexpected transport scheduling issues',                      10),
  ('Unforeseen medical leave for our assigned driver',            20),
  ('Sudden mechanical breakdown of our delivery vehicle',         30),
  ('Unavoidable technical issues with our transport arrangement', 40),
  ('Our strict quality control checks',                           50),
  ('Materials being temporarily out of stock',                    60),
  ('Unforeseen production constraints',                           70),
  ('A public holiday falling on your delivery day',               80)
) AS v(label, sort_order)
CROSS JOIN public.companies co
WHERE co.is_active = 1
ON CONFLICT (company_id, label) DO NOTHING;

-- REVERSAL: DROP TABLE IF EXISTS scm.delivery_amend_reasons;
