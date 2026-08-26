-- 0331_departments_lead_and_headcount — give a department a REAL lead and an
-- optional headcount target.
--
-- The Team redesign showed a department's lead and its "N / target" headcount,
-- but the schema carried neither: the lead was DERIVED from manager_id
-- (teamShared.deriveDeptLead) and the target did not exist at all (the design's
-- "/45" was a placeholder). Owner 2026-08-26: make the lead a real, settable
-- field (default none — super-admin managed, assigned later) and let HR fill an
-- optional headcount target per department.
--
-- 白话（老板版）。部门「负责人」以前是系统按谁管谁猜出来的，不是真的选出来的；设计稿
-- 里那个「编制 /45」根本没这列。这一版给部门加两根真列：lead_user_id（负责人，默认空=
-- 还没指定，红色 No lead；删人自动置空不挡事）和 headcount_target（编制目标，HR 可选填，
-- 空=只显示实时人数）。都是加列、幂等，正式库上是安全的增量。
--
-- Reversal: repo-tracking only, never casually on prod — the Departments screen
-- reads both columns. To undo the tracking on a throwaway DB: ALTER TABLE
-- departments DROP COLUMN IF EXISTS headcount_target; ALTER TABLE departments
-- DROP COLUMN IF EXISTS lead_user_id;
-- Verified against: the live Supabase prod catalog (departments has id/name/
-- description/color/sort_order/created_at and neither new column), so both
-- ADD COLUMN IF NOT EXISTS run once and are no-ops on any environment that
-- already has them. Additive only — no data is read or rewritten.

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS lead_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS headcount_target INTEGER;
