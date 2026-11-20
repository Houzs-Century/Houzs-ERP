-- 20261120T1400_scm_stock_take_approval.sql
-- REVERSAL:
--   ALTER TABLE scm.stock_takes
--     DROP COLUMN IF EXISTS submitted_at,
--     DROP COLUMN IF EXISTS submitted_by;
--   (A take already approved to POSTED, or returned to OPEN, keeps its real
--   status; these two columns only record who sent an over-limit count for
--   approval and when, so dropping them loses that record, nothing derived.)
--
-- 白话。盘点审批（老板 2026-11-20）：以前普通员工 Post 一张差异超限（默认 5 件 或
-- RM500/行）的盘点，会被硬拦下来，什么都不写，必须主管亲自过账。现在改成：普通员工
-- 照样能提交，单据进入「待审批」(PENDING_APPROVAL)，主管点「批准」才正式入账(写调整)、
-- 点「退回」就回到 OPEN 让人重数。这两列记下是谁、什么时候提交的。
--
-- status 是普通 text 列（没有 enum、没有 check 约束），所以新增的
-- 'PENDING_APPROVAL' 值不需要改类型；只要加这两列记录提交人即可。submitted_by 存
-- scm.staff 的 uuid（和 assignee_staff_id 一样，仅作记录，不加外键）。

ALTER TABLE scm.stock_takes
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_by uuid;
