-- 0196_scm_delivery_residence_rules.sql — CONFIGURABLE residence / building-type
-- delivery rules, the data foundation the TMS Phase 3 scheduler will consume
-- (service duration + delivery access windows per residence type).
--
-- WHY A TABLE, NOT A UDF. The residence types themselves already live as free
-- text on the SO (scm.mfg_sales_orders.building_type, UDF options seeded in
-- 0022: Condo / Landed / Apartment / Office / Shop / Other). This table keys ON
-- those values and hangs the OWNER-EDITABLE scheduling rules off each one:
-- how long a delivery to that residence type takes to unload + carry up, and any
-- access restriction (condo no-delivery windows, service-lift booking, gated-
-- community registration). The owner sets the exact numbers; these are seeds.
--
-- MULTI-COMPANY. Scoped per company exactly like the other scm masters
-- (delivery_planning_regions et al): company_id NOT NULL, per-company UNIQUE on
-- (company_id, building_type) so each company holds its own rule set and a third
-- company can reuse the same type codes without colliding (mirrors 0092 / 0188).
--
-- CANONICAL SEED, NOT DEMO DATA. The six building_type values are the same
-- canonical UDF options 0022 seeds — lookup/config rows that belong in a
-- numbered migration (repo rule: canonical enum/lookup rows ship in migrations,
-- fake sample rows do not). Seeded for EVERY active company via a cross join, so
-- HOUZS and 2990 (and any future company) start with a complete, editable set.
-- All default to 90 minutes (owner guidance: ~1.5h for most types); Landed
-- defaults to 60 minutes (usually unrestricted, ground-floor). Every value stays
-- editable in the admin UI afterwards.
--
-- HOUSE STYLE. Additive, idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING),
-- schema-qualified, no runtime self-apply. pg-migrate runs the whole file in one
-- transaction.

SET search_path = scm, public;

CREATE TABLE IF NOT EXISTS scm.delivery_residence_rules (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                BIGINT NOT NULL REFERENCES public.companies(id),
  building_type             TEXT NOT NULL,
  service_duration_minutes  INTEGER NOT NULL DEFAULT 90 CHECK (service_duration_minutes >= 0),
  earliest_delivery_time    TIME NULL,
  latest_delivery_time      TIME NULL,
  requires_lift_booking     BOOLEAN NOT NULL DEFAULT false,
  requires_registration     BOOLEAN NOT NULL DEFAULT false,
  notes                     TEXT NULL,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  created_by                UUID NULL,
  updated_by                UUID NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_residence_rules_company_type_uq UNIQUE (company_id, building_type)
);

CREATE INDEX IF NOT EXISTS idx_delivery_residence_rules_company
  ON scm.delivery_residence_rules (company_id);
CREATE INDEX IF NOT EXISTS idx_delivery_residence_rules_active
  ON scm.delivery_residence_rules (company_id, is_active);

-- Seed the canonical building_type rows for EVERY active company. Landed keeps
-- the lighter 60-minute default (ground-floor, usually unrestricted); everything
-- else takes the 90-minute (~1.5h) default. All owner-editable afterwards.
INSERT INTO scm.delivery_residence_rules (company_id, building_type, service_duration_minutes)
SELECT co.id, v.building_type, v.mins
FROM (VALUES
  ('Condo',     90),
  ('Landed',    60),
  ('Apartment', 90),
  ('Office',    90),
  ('Shop',      90),
  ('Other',     90)
) AS v(building_type, mins)
CROSS JOIN public.companies co
WHERE co.is_active = 1
ON CONFLICT (company_id, building_type) DO NOTHING;
