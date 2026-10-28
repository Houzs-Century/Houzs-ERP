-- ASSR case numbers: make the duplicate-number race impossible going forward.
--
-- nextAssrNumber (services/assr.ts) is read-max-then-+1 with no lock, so two
-- concurrent creates could mint the same number. Prod carries exactly 8 rows
-- that already collided (owner-audited 2026-07-28, all Closed historical
-- imports from April: ASSR/2604-043 x6 display-set cases ids 1223-1228,
-- ASSR/2604-017 x2 ids 1200-1201). Owner ruling: KEEP those numbers as-is —
-- renumbering closed, already-printed cases would desync the sheet mirror and
-- every paper copy — and guard the future instead.
--
-- Partial unique index: uniqueness for every row EXCEPT the 8 grandfathered
-- ids. The create path retries with a fresh number on a violation.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assr_cases_assr_no
  ON public.assr_cases (assr_no)
  WHERE id NOT IN (1200, 1201, 1223, 1224, 1225, 1226, 1227, 1228);
