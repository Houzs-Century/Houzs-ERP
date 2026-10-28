-- 0327_scm_fleet_user_link — track the fleet↔account link the code already reads.
--
-- REVERSAL: the columns/indexes are populated in production and read by
-- scm/lib/deliveryScope.ts, so this is not casually reversed. To undo the
-- REPO-TRACKING only (never on prod): DROP INDEX IF EXISTS
-- scm.idx_drivers_user_id, scm.idx_helpers_user_id; ALTER TABLE scm.drivers
-- DROP COLUMN IF EXISTS user_id; ALTER TABLE scm.helpers DROP COLUMN IF EXISTS
-- user_id; — dropping the column disables driver row-isolation (deliveryScope
-- fails open), so only ever do this on a throwaway DB.
--
-- 白话（老板版）。司机/助手账号跟花名册的绑定列（user_id）在正式库里早就手工加好、
-- 也建了索引、还填了数据（5 个自有车司机全绑了），可是从来没写进迁移文件——所以
-- 代码在读一根「树里不存在」的列。这一版把它补进迁移，正式库上是空操作（IF NOT
-- EXISTS），只是让重建/别的环境跟正式库一致。司机「只看自己的单」就是靠这根绑定。
--
-- WHY. scm/lib/deliveryScope.ts narrows a Driver/Helper to their OWN delivery
-- jobs by looking up scm.drivers / scm.helpers WHERE user_id = <caller>. That
-- column exists in production (hand-applied, with a supporting index, both
-- verified 2026-08-25) but NO migration created it, so a fresh rebuild — or a
-- schema-audit — would not have it and the lookup would fail open. This makes
-- the tracked schema match the live one. Additive and idempotent throughout;
-- guarded so it is a no-op where the fleet tables do not exist.

SET search_path = scm, public;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'scm' AND c.relname = 'drivers' AND c.relkind IN ('r', 'p')
  ) THEN
    ALTER TABLE scm.drivers ADD COLUMN IF NOT EXISTS user_id integer;
    CREATE INDEX IF NOT EXISTS idx_drivers_user_id ON scm.drivers (user_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'scm' AND c.relname = 'helpers' AND c.relkind IN ('r', 'p')
  ) THEN
    ALTER TABLE scm.helpers ADD COLUMN IF NOT EXISTS user_id integer;
    CREATE INDEX IF NOT EXISTS idx_helpers_user_id ON scm.helpers (user_id);
  END IF;
END $$;
