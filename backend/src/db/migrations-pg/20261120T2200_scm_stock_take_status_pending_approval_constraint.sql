-- 20261120T2200_scm_stock_take_status_pending_approval_constraint.sql
-- REVERSAL:
--   ALTER TABLE scm.stock_takes DROP CONSTRAINT IF EXISTS stock_takes_status_chk;
--   ALTER TABLE scm.stock_takes ADD CONSTRAINT stock_takes_status_chk
--     CHECK (status = ANY (ARRAY['OPEN'::text, 'POSTED'::text, 'CANCELLED'::text]));
--   (Reverting re-forbids PENDING_APPROVAL — safe only once no take sits in that
--   state, or the restored constraint would reject the existing row.)
--
-- 白话（线上 bug 修复，老板 2026-11-20）。盘点审批（PR #5858）上线后，普通员工 post 一张
-- 差异超限的盘点时，系统要把单据置为 PENDING_APPROVAL（待审批），但生产库上 stock_takes 有
-- 一条 CHECK 约束只允许 OPEN/POSTED/CANCELLED，于是这个 UPDATE 被数据库拒绝、前台报「系统
-- 出了点问题」。这条约束一直只在生产库里、不在 migration 文件中，所以 CI 的测试库没有它、测
-- 不出来。这里把约束重建为包含 PENDING_APPROVAL：既修好线上，也把约束纳入 migration（以后 CI
-- 库也有，改状态集合时会一起管住，不会再漂移）。
--
-- DROP IF EXISTS then ADD: the migration tracker runs this once, so the ADD lands
-- on a table that has no such constraint after the drop. On a database that never
-- had the constraint (CI / staging) the DROP is a no-op and the ADD creates it.

ALTER TABLE scm.stock_takes DROP CONSTRAINT IF EXISTS stock_takes_status_chk;
ALTER TABLE scm.stock_takes ADD CONSTRAINT stock_takes_status_chk
  CHECK (status = ANY (ARRAY['OPEN'::text, 'PENDING_APPROVAL'::text, 'POSTED'::text, 'CANCELLED'::text]));
