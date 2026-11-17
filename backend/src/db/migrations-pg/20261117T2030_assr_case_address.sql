-- 20261117T2030_assr_case_address.sql
-- REVERSAL: DROP TABLE IF EXISTS public.assr_case_address;
--   The table is new; dropping it loses only the Postcode / City / State typed
--   or filled from the SO on a service case. The address lines stay on
--   assr_cases.addr1..addr4. GRANTS: the ones below.
--
-- WHY (owner 2026-11-17). A service case kept its address as one free-text
-- box (assr_cases.addr1..addr4) plus a "Location" branch code, so Delivery
-- Planning and Last Mile could only guess the postcode / state from the text.
-- The case now holds the address the way the Sales Order does: address lines +
-- Postcode + City + State, filled from the SO when the SO is picked and
-- editable through the same my_localities cascade. Values are plain text,
-- checked at the API (scm/shared/assr-case-address.ts), like the SO's own
-- postcode / city / customer_state.
--
-- WHY NOT COLUMNS ON assr_cases: the case list and detail read c.* plus joined
-- columns and the D1 test mirror caps a result set at 100 columns; three more
-- columns broke every list / detail test the last time (see
-- 20261021T1000_assr_verification_findings.sql and
-- 20261110T1400_assr_return_dos_and_qc_notes.sql). Same fix: a 1:1 table.
--
-- No backfill here: existing cases keep reading the linked SO's postcode /
-- state as before (Delivery Planning, the delivery sheet). Filling the table
-- from the SO for old cases is backend/scripts/backfill-assr-case-address.mjs
-- (plan by default).
SET search_path = public;

CREATE TABLE IF NOT EXISTS public.assr_case_address (
  assr_id     bigint      PRIMARY KEY,
  postcode    text,
  city        text,
  state       text,
  updated_by  bigint,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='assr_case_address_assr_id_fkey') THEN ALTER TABLE public.assr_case_address ADD CONSTRAINT assr_case_address_assr_id_fkey FOREIGN KEY (assr_id) REFERENCES public.assr_cases(id) ON DELETE CASCADE; END IF; END $$;

ALTER TABLE public.assr_case_address ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assr_case_address TO service_role;
