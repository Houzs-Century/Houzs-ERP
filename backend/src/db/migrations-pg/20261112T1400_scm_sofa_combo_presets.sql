-- 20261112T1400_scm_sofa_combo_presets.sql
--
-- WHY. Owner 2026-11-12: the "Start from: Preset" list in Products > Combo
-- Pricing > New combo was hard-coded in the frontend (comboBook.ts
-- COMBO_PRESETS), so adding or renaming a preset needed a code change. The
-- presets now live here and are maintained from the "Presets" button on the
-- Sofa Combo Pricing screen (route scm/routes/sofa-combo-presets.ts).
--
-- A PRESET is a name and its compartments: `slots` is a jsonb string[][], one
-- inner array per slot, each slot the module codes that may fill it. It is the
-- same shape sofa_combo_pricing.modules carries and fitSlots() reads. A code
-- with no side, e.g. "2A", stands for either side of that module on the model
-- the combo is added to; "2A(LHF)" means that side only.
--
-- MULTI-COMPANY. company_id on every row; the route scopes every read and
-- write to the active company. A name is unique within a company, ignoring
-- case. Presets are switched off (active = false), never deleted, so the list
-- keeps its history.
--
-- SEED. The five rows inserted below are REAL CONFIGURATION, not demo data:
-- they are exactly the five presets the frontend hard-coded until this PR
-- (L shape, 3 + 2 + 1, Corner set, Corner with chaise, 2 + 1), seeded for every
-- existing company so the New combo dialog shows the same list on the day this
-- ships. Idempotent: a company that already has a preset of that name is left
-- alone. A company created later starts with no presets and adds its own.
--
-- HOUSE STYLE. Additive, idempotent, schema-qualified. RE-CHECK THE NUMBER AT
-- MERGE.
--
-- REVERSAL:
--   DROP TABLE IF EXISTS scm.sofa_combo_presets;

CREATE TABLE IF NOT EXISTS scm.sofa_combo_presets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  BIGINT NOT NULL REFERENCES public.companies(id),
  name        TEXT NOT NULL,
  slots       JSONB NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sofa_combo_presets_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT sofa_combo_presets_slots_array CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS sofa_combo_presets_company_name_uq
  ON scm.sofa_combo_presets (company_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_sofa_combo_presets_company_order
  ON scm.sofa_combo_presets (company_id, sort_order);

-- Like every scm table (mig 0061): RLS on with no policy, so only the service
-- role the Worker uses reads or writes it.
ALTER TABLE scm.sofa_combo_presets ENABLE ROW LEVEL SECURITY;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON scm.sofa_combo_presets TO service_role;
  END IF;
END
$grant$;

-- The five presets the frontend hard-coded (real configuration, see SEED above).
INSERT INTO scm.sofa_combo_presets (company_id, name, slots, sort_order)
SELECT c.id, p.name, p.slots::jsonb, p.sort_order
FROM public.companies c
CROSS JOIN (VALUES
  ('L shape',            '[["2A"],["L"]]',          0),
  ('3 + 2 + 1',          '[["1S"],["2S"],["3S"]]',  1),
  ('Corner set',         '[["2A"],["CNR"],["1A"]]', 2),
  ('Corner with chaise', '[["2A"],["CNR"],["L"]]',  3),
  ('2 + 1',              '[["1S"],["2S"]]',         4)
) AS p(name, slots, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM scm.sofa_combo_presets e
  WHERE e.company_id = c.id AND lower(e.name) = lower(p.name)
);

COMMENT ON TABLE scm.sofa_combo_presets IS
  'Presets offered by Products > Combo Pricing > New combo: a name and its slots (jsonb string[][], the sofa_combo_pricing.modules shape). '
  'A code with no side stands for either side on the model. Maintained from the Presets button; see scm/routes/sofa-combo-presets.ts.';

NOTIFY pgrst, 'reload schema';
