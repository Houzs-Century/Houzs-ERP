-- 154_assr_case_access.sql
--
-- D1 / TEST-MIRROR twin of migrations-pg/20260911T1600_assr_case_access.sql.
--
-- This tree is test-only now (production runs migrations-pg via Hyperdrive), so
-- this file changes NOTHING in prod. It exists so the ASSR row-visibility clause
--   EXISTS (SELECT 1 FROM assr_case_access acc WHERE acc.assr_id = c.id
--           AND acc.user_id IN (<subtree ids>))
-- resolves against the D1 test schema instead of throwing "no such table". Keep
-- in lock-step with the pg twin; see docs/modules/service-case.md section 6.
--
-- SQLite syntax: INTEGER user ids (the D1 mirror types assigned_to_2 / company_id
-- as INTEGER), text created_at, no FK (the mirror omits them broadly).

CREATE TABLE IF NOT EXISTS assr_case_access (
  assr_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  added_by   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assr_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_assr_case_access_user ON assr_case_access (user_id);
