-- 20261120T1800_scm_stock_adjustment_from_stock_take.sql
-- REVERSAL:
--   DROP INDEX IF EXISTS scm.idx_stock_adjustments_source_stock_take;
--   ALTER TABLE scm.stock_adjustments DROP COLUMN IF EXISTS source_stock_take_id;
--   (Mirror adjustment documents already created for posted takes stay; they lose
--   only the back-link, so the stock take's "View adjustment" link goes dark —
--   no stock moves, nothing is un-booked.)
--
-- 白话。老板 2026-11-20：盘点过账有差异时，除了照旧写库存调整动作，还自动开一张
-- 正式的 Stock Adjustment 单（SA 编号），这样采购/库管能在 Stock Adjustments 列表里
-- 直接看到这笔调整，盘点单也能点进去（不用去 stock card）。这一列把那张 SA 单链回它
-- 的来源盘点单，并标记它是「盘点自动生成」的——这种单只读、不能手工改/删，撤销盘点时
-- 连它一起删掉。库存只动一次（还是盘点那套动作），这张 SA 单不另写库存动作。

ALTER TABLE scm.stock_adjustments
  ADD COLUMN IF NOT EXISTS source_stock_take_id uuid
    REFERENCES scm.stock_takes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stock_adjustments_source_stock_take
  ON scm.stock_adjustments (source_stock_take_id)
  WHERE source_stock_take_id IS NOT NULL;
