-- 20261110T1400_assr_return_dos_and_qc_notes.sql
-- REVERSAL:
--   DROP TABLE IF EXISTS public.assr_case_qc_notes;
--   DROP TABLE IF EXISTS public.assr_return_dos;
--   Both new; dropping them loses only the supplier DOs and QC details typed on
--   the Pending Item Ready step. GRANTS: the ones below.
--
-- WHY (Operation Dept, 2026-11-09). Pending Item Ready gets one place to track
-- the repaired item coming back: the supplier's delivery orders (more than one
-- per case), the date each was received and by whom, and the QC inspection
-- (date, who did it, findings). The QC result itself stays on the current
-- supplier return trip (assr_supplier_returns.qc_result) and the route stays
-- assr_cases.inspection_result, so nothing is typed twice. Dates are
-- YYYY-MM-DD text, checked at the API, like the other ASSR dates.
--
-- WHY THE QC FIELDS ARE NOT COLUMNS ON assr_cases: the case list and detail
-- read c.* plus joined columns, and the D1 test mirror caps a result set at 100
-- columns. Three more columns broke every list / detail test. Same fix as
-- assr_case_verification_notes (20261021T1000): a 1:1 table, read only by the
-- detail. Replaces the unmerged 20261109T1300_assr_return_dos_qc.sql, which ran
-- on staging only.
SET search_path = public;

CREATE TABLE IF NOT EXISTS public.assr_return_dos (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assr_id      bigint      NOT NULL,
  do_no        text        NOT NULL,
  do_date      text,
  received_at  text,
  received_by  text,
  remarks      text,
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assr_return_dos_assr_id_fkey') THEN ALTER TABLE public.assr_return_dos ADD CONSTRAINT assr_return_dos_assr_id_fkey FOREIGN KEY (assr_id) REFERENCES public.assr_cases(id) ON DELETE CASCADE; END IF; END $$;

CREATE INDEX IF NOT EXISTS idx_assr_return_dos_case ON public.assr_return_dos (assr_id);

ALTER TABLE public.assr_return_dos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assr_return_dos TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.assr_return_dos_id_seq TO service_role;

CREATE TABLE IF NOT EXISTS public.assr_case_qc_notes (
  assr_id          bigint      PRIMARY KEY,
  qc_inspected_at  text,
  qc_by            text,
  qc_findings      text,
  updated_by       bigint,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assr_case_qc_notes_assr_id_fkey') THEN ALTER TABLE public.assr_case_qc_notes ADD CONSTRAINT assr_case_qc_notes_assr_id_fkey FOREIGN KEY (assr_id) REFERENCES public.assr_cases(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.assr_case_qc_notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assr_case_qc_notes TO service_role;
