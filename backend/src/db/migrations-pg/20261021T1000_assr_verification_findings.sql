-- 20261021T1000_assr_verification_findings.sql
-- REVERSAL: DROP TABLE IF EXISTS public.assr_case_verification_notes;
--   The table is new; dropping it loses only what was typed on the
--   Verification step. GRANTS: none touched.
--
-- HC-0133 (Operation Dept, 2026-10-20): the Verification step records what the
-- inspection found and who the case now waits on, next to the existing
-- verified_root_cause. One row per case.
--   inspection_findings  free text: what was checked, found and done
--   next_action          free text: repair on-site, pickup for service, ...
--   pending_with         'supplier' | 'production' | 'logistics' | 'customer' | 'management' | NULL
-- Allowed values are checked at the API (scm/shared/assr-verification-fields.ts),
-- not by a CHECK constraint.
--
-- WHY NOT COLUMNS ON assr_cases. The case list and detail read c.* plus ~13
-- joined / computed columns. The D1 test mirror caps a result set at 100
-- columns and those two reads sat at 98 after HC-0129, so three more columns
-- failed every list / detail test. Postgres has no such cap, but the tests run
-- on D1. A 1:1 table keeps both reads unchanged; only the detail reads it.
--
-- Houzs conventions: additive, IF NOT EXISTS, re-runnable; no inner
-- BEGIN/COMMIT; one-line DO block (the runner splits on ';\n').
SET search_path = public;

CREATE TABLE IF NOT EXISTS public.assr_case_verification_notes (
  assr_id             bigint      PRIMARY KEY,
  inspection_findings text,
  next_action         text,
  pending_with        text,
  updated_by          bigint,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assr_case_verification_notes_assr_id_fkey') THEN ALTER TABLE public.assr_case_verification_notes ADD CONSTRAINT assr_case_verification_notes_assr_id_fkey FOREIGN KEY (assr_id) REFERENCES public.assr_cases(id) ON DELETE CASCADE; END IF; END $$;
