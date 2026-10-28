-- D1 test mirror of migrations-pg/0218: partial unique index on
-- assr_cases.assr_no, excluding the 8 grandfathered prod ids that already
-- share a number (ASSR/2604-043 x6, ASSR/2604-017 x2 — kept by owner ruling
-- 2026-07-28). Test fixtures never use those ids, so locally this is simply
-- a unique assr_no; it exists here so the create path's conflict-retry loop
-- is exercised by tests the same way prod behaves.
CREATE UNIQUE INDEX IF NOT EXISTS uq_assr_cases_assr_no
  ON assr_cases(assr_no)
  WHERE id NOT IN (1200, 1201, 1223, 1224, 1225, 1226, 1227, 1228);
